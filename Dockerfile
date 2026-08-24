# مرحله ۱: به‌جای کامپایل از سورس (که رم بیلد Railway رو پر می‌کرد و بی‌صدا
# OOM می‌خورد)، باینری از‌قبل‌کامپایل‌شده‌ی telegram-bot-api رو از یه ایمیج
# معتبر و شناخته‌شده می‌گیریم. توجه: این ایمیج روی Alpine/musl ساخته شده،
# برای همین مرحله ۲ هم باید Alpine باشه وگرنه لودر باینری پیدا نمی‌شه
# (خطای "cannot execute: required file not found").
FROM aiogram/telegram-bot-api:latest AS botapi-build

# مرحله ۲: ایمیج اصلی - Alpine تا با musl باینری بالا سازگار باشه
FROM python:3.11-alpine

RUN apk add --no-cache \
        bash \
        ffmpeg \
        aria2 \
        wget \
        ca-certificates

# باینری Local Bot API Server را از مرحله قبل کپی می‌کنیم
COPY --from=botapi-build /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bot.py start.sh ./
RUN chmod +x start.sh /usr/local/bin/telegram-bot-api

# دیسک کاری - همون فضای ephemeral رایگان Space (تا ۵۰ گیگ)
RUN mkdir -p /data/botapi /data/work

# Render پورت رو خودش از طریق متغیر محیطی PORT به کانتینر می‌ده و bot.py
# از قبل همون PORT رو می‌خونه (پیش‌فرض 7860 فقط برای اجرای لوکاله)
EXPOSE 10000

CMD ["./start.sh"]
