#!/bin/bash
# 다운로드 폴더 내의 브라우저 비호환 MKV/EAC3 영상을 브라우저 네이티브 MP4(AAC 오디오)로 즉시 1:1 고속 복사 변환
# 비디오는 원본 100% 그대로 copy(화질 저하 0%, 속도 초고속), 오디오만 AAC로 변환하여 브라우저에서 전체 탐색바(0:00 ~ 전체길이) 자유 탐색 가능
SOURCE_DIR="/home/kw/Downloads"
find "$SOURCE_DIR" -type f -name "*.mkv" | while read -r file; do
  dir=$(dirname "$file")
  base=$(basename "$file" .mkv)
  out="$dir/${base}.mp4"
  if [ ! -f "$out" ]; then
    echo "Converting: $file -> $out"
    /home/kw/.local/bin/kw-ffmpeg -i "$file" -map 0:v:0 -map 0:a:0? -c:v copy -c:a aac -b:a 256k -ac 2 -movflags +faststart "$out" -y
  fi
done
