# مرحله ۱: به‌جای کامپایل از سورس (که رم بیلد Railway رو پر می‌کرد و بی‌صدا
# OOM می‌خورد)، باینری از‌قبل‌کامپایل‌شده‌ی telegram-bot-api رو از یه ایمیج
# معتبر و شناخته‌شده (بیس Debian، سازگار با glibc همین ایمیج پایین) می‌گیریم.
FROM aiogram/telegram-bot-api:latest AS botapi-build

# مرحله ۲: ایمیج اصلی
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        aria2 \
        wget \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# باینری Local Bot API Server را از مرحله قبل کپی می‌کنیم
COPY --from=botapi-build /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bot.py start.sh ./
RUN chmod +x start.sh

# دیسک کاری - همون فضای ephemeral رایگان Space (تا ۵۰ گیگ)
RUN mkdir -p /data/botapi /data/work

# Render پورت رو خودش از طریق متغیر محیطی PORT به کانتینر می‌ده و bot.py
# از قبل همون PORT رو می‌خونه (پیش‌فرض 7860 فقط برای اجرای لوکاله)
EXPOSE 10000

CMD ["./start.sh"]
