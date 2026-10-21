import fs from 'node:fs';
import path from 'node:path';

// Codex reads the instance source directly; it must never synchronize to DSH_HOME.
export function runtimePresetPath({backend,source,dshHome,name}) {
  return backend === 'codex' ? source : path.join(dshHome,'.agent-presets',name,'agent.cordis.yml');
}

export function syncPresetCopy(options) {
  const target=runtimePresetPath(options);
  if(target!==options.source && fs.existsSync(target))fs.copyFileSync(options.source,target);
  return fs.existsSync(target);
}
