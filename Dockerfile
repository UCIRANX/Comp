# مرحله ۱: خودمون telegram-bot-api رو از سورس، روی همون بیس Debian بیلد می‌کنیم
# (ایمیج‌های آماده معمولا Alpine/musl هستن و روی Debian/glibc اجرا نمی‌شن)
FROM debian:trixie-slim AS botapi-build

ENV CXXFLAGS=""
WORKDIR /usr/src/telegram-bot-api

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake git zlib1g-dev libssl-dev gperf ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --recursive https://github.com/tdlib/telegram-bot-api.git .

RUN mkdir -p build && cd build \
    && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX:PATH=.. .. \
    && cmake --build . --target install -j2 \
    && strip /usr/src/telegram-bot-api/bin/telegram-bot-api

# مرحله ۲: ایمیج اصلی
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        aria2 \
        wget \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# باینری Local Bot API Server را از مرحله قبل کپی می‌کنیم
COPY --from=botapi-build /usr/src/telegram-bot-api/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

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
