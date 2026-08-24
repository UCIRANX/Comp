#!/bin/bash
set -e

: "${API_ID:?متغیر محیطی API_ID تنظیم نشده}"
: "${API_HASH:?متغیر محیطی API_HASH تنظیم نشده}"
: "${BOT_TOKEN:?متغیر محیطی BOT_TOKEN تنظیم نشده}"

echo "[start.sh] در حال راه‌اندازی Local Bot API Server ..."

telegram-bot-api \
    --api-id="$API_ID" \
    --api-hash="$API_HASH" \
    --local \
    --dir=/data/botapi \
    --temp-dir=/data/botapi/tmp \
    --http-port=8081 \
    --max-webhook-connections=0 &

BOTAPI_PID=$!

# منتظر می‌مونیم سرور بالا بیاد
for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:8081/bot${BOT_TOKEN}/getMe" > /dev/null 2>&1; then
        echo "[start.sh] Local Bot API Server آماده است."
        break
    fi
    sleep 1
done

python3 bot.py

# اگر بات به هر دلیلی متوقف شد، سرور محلی هم ببندیم
kill "$BOTAPI_PID" 2>/dev/null || true
