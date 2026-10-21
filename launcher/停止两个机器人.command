#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/usr/sbin:/sbin:$PATH"
node scripts/robots.mjs stop
result=$?
if [ "$result" -ne 0 ]; then
  printf '\n停止未完成，请查看上面的提示。按回车关闭…'
  read -r _
fi
exit "$result"
