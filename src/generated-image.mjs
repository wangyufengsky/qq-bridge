import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;
// Only artifacts belonging to the current backend thread can leave that QQ conversation.
export function readGeneratedImage({home, sessionId, filePath}) {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId || '')) throw Error('GENERATED_IMAGE_SESSION_REQUIRED');
  const base = path.resolve(home, 'generated_images', sessionId);
  const candidate = path.resolve(base, String(filePath || ''));
  if (path.dirname(candidate) !== base) throw Error('GENERATED_IMAGE_OUTSIDE_SESSION');
  if (!fs.existsSync(base)) throw Error('GENERATED_IMAGE_NOT_FOUND');
  const canonicalBase = path.join(fs.realpathSync(home), 'generated_images', sessionId);
  if (fs.realpathSync(base) !== canonicalBase) throw Error('GENERATED_IMAGE_SYMLINK_DENIED');
  if (!fs.existsSync(candidate)) throw Error('GENERATED_IMAGE_NOT_FOUND');
  if (fs.realpathSync(candidate) !== path.join(canonicalBase, path.basename(candidate)) || fs.lstatSync(candidate).isSymbolicLink()) throw Error('GENERATED_IMAGE_SYMLINK_DENIED');
  const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw Error('GENERATED_IMAGE_REGULAR_FILE_REQUIRED');
    if (!st.size || st.size > MAX_GENERATED_IMAGE_BYTES) throw Error('GENERATED_IMAGE_SIZE_LIMIT');
    const buffer = Buffer.alloc(st.size);
    if (fs.readSync(fd, buffer, 0, st.size, 0) !== st.size) throw Error('GENERATED_IMAGE_CHANGED');
    const png = buffer.length > 24 && buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
    const jpeg = buffer.length > 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const webp = buffer.length > 12 && buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WEBP';
    if (!png && !jpeg && !webp) throw Error('GENERATED_IMAGE_FORMAT_UNSUPPORTED');
    return {buffer, bytes:buffer.length, digest:crypto.createHash('sha256').update(buffer).digest('hex')};
  } finally { fs.closeSync(fd); }
}

export async function deliverGeneratedImage({image,key,sessionId,receiptFile,httpUrl,accessToken,guard,fetchImpl=fetch}) {
  let receipts={};
  if (fs.existsSync(receiptFile)) receipts=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
  const id=crypto.createHash('sha256').update(`${key}:${sessionId}:${image.digest}`).digest('hex');
  const old=receipts[id];
  if(old?.status==='sent')return {...old,duplicate:true};
  if(old)throw Error('IMAGE_RECEIPT_UNKNOWN: 请管理员核对回执，不要自动重发');
  guard();
  const save=()=>{fs.writeFileSync(receiptFile+'.tmp',JSON.stringify(receipts),{mode:0o600});fs.renameSync(receiptFile+'.tmp',receiptFile);};
  receipts[id]={status:'pending',key,sessionId,createdAt:new Date().toISOString()};save();
  const [kind,target]=key.split(':');
  if(!['group','private'].includes(kind)||!/^\d+$/.test(target))throw Error('INVALID_TARGET');
  const action=kind==='group'?'send_group_msg':'send_private_msg';
  const message=[{type:'image',data:{file:'base64://'+image.buffer.toString('base64')}}];
  // Pending survives process crashes/timeouts: a retry must not silently duplicate a sent image.
  const response=await fetchImpl(`${httpUrl.replace(/\/+$/,'')}/${action}`,{
    method:'POST',headers:{'content-type':'application/json',...(accessToken?{authorization:`Bearer ${accessToken}`}:{})},
    body:JSON.stringify({[kind==='group'?'group_id':'user_id']:Number(target),message}),signal:AbortSignal.timeout(30000)});
  const result=await response.json();
  if(!response.ok || result.status!=='ok' || result.retcode!==0 || !result.data?.message_id)
    throw Error('IMAGE_DELIVERY_UNCONFIRMED: 请管理员核对网关回执');
  const receipt={status:'sent',key,sessionId,messageId:String(result.data.message_id),bytes:image.bytes,createdAt:receipts[id].createdAt};
  receipts[id]=receipt;save();return receipt;
}
