import asyncio
import json
import logging
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, unquote

from aiohttp import web
from aiogram import Bot, Dispatcher, F
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.types import Message, FSInputFile, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.filters import CommandStart, Command
from aiogram.utils.keyboard import InlineKeyboardBuilder

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tgvideobot")

# ---------------------------------------------------------------------------
# تنظیمات از متغیرهای محیطی
# ---------------------------------------------------------------------------
BOT_TOKEN = os.environ["BOT_TOKEN"]
LOCAL_API_BASE = os.environ.get("LOCAL_API_BASE", "http://127.0.0.1:8081")
WORK_DIR = Path(os.environ.get("WORK_DIR", "/data/work"))
SETTINGS_PATH = Path(os.environ.get("SETTINGS_PATH", "/data/settings.json"))
HTTP_PORT = int(os.environ.get("PORT", "7860"))

_allowed = os.environ.get("ALLOWED_USER_IDS", "").strip()
ALLOWED_USER_IDS = {int(x) for x in _allowed.split(",") if x.strip()} if _allowed else None

ENV_DEFAULT_CRF = int(os.environ.get("FFMPEG_CRF", "26"))
FFMPEG_PRESET = os.environ.get("FFMPEG_PRESET", "faster")
FFMPEG_AUDIO_BITRATE = os.environ.get("FFMPEG_AUDIO_BITRATE", "96k")

MIN_CRF, MAX_CRF = 0, 51
MIN_DIM, MAX_DIM_LIMIT = 16, 8000

WORK_DIR.mkdir(parents=True, exist_ok=True)

URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
VIDEO_EXTS = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".flv", ".wmv", ".ts"}

session = AiohttpSession(api=TelegramAPIServer.from_base(LOCAL_API_BASE, is_local=True))
bot = Bot(token=BOT_TOKEN, session=session)
dp = Dispatcher()


class JobCancelled(Exception):
    pass


# ---------------------------------------------------------------------------
# تنظیمات سراسری (پیش‌فرض‌هایی که با /settings قابل تغییرن، روی دیسک ذخیره می‌شن)
# نکته: چون دیسک Space رایگان ephemeral هست، این فایل با هر بازسازی/دیپلوی
# جدید Space از نو به مقدار اولیه (متغیرهای محیطی) برمی‌گرده.
# ---------------------------------------------------------------------------
@dataclass
class GlobalSettings:
    default_mode: str = "original"                 # "mkv" | "original"
    default_crf: int = ENV_DEFAULT_CRF
    default_max_dim: Optional[int] = None      # None یعنی بدون تغییر ابعاد


def load_settings() -> GlobalSettings:
    if SETTINGS_PATH.exists():
        try:
            data = json.loads(SETTINGS_PATH.read_text())
            return GlobalSettings(**data)
        except Exception:
            log.warning("failed to load settings.json, using defaults")
    return GlobalSettings()


def save_settings() -> None:
    try:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_PATH.write_text(json.dumps(asdict(settings), ensure_ascii=False))
    except Exception:
        log.exception("failed to save settings.json")


settings = load_settings()


@dataclass
class Job:
    job_id: str
    chat_id: int
    user_id: int
    source_type: str            # "url" | "file"
    filename: str
    url: Optional[str] = None
    tg_file_id: Optional[str] = None
    mode: str = field(default_factory=lambda: settings.default_mode)
    preset: str = "default"     # "default" | "manual"
    max_dim: Optional[int] = field(default_factory=lambda: settings.default_max_dim)
    crf: int = field(default_factory=lambda: settings.default_crf)
    settings_msg_id: Optional[int] = None
    cancelled: bool = False
    current_proc: Optional[asyncio.subprocess.Process] = None


jobs: dict[str, Job] = {}
awaiting_input: dict[int, tuple[str, str]] = {}   # user_id -> (job_id | "__global__", field)
job_queue: asyncio.Queue = asyncio.Queue()
queued_order: list[str] = []           # ترتیب کارهای در صف (برای نمایش در /queue)
current_job_id: Optional[str] = None   # کاری که همین الان داره پردازش می‌شه


def is_allowed(user_id: int) -> bool:
    return ALLOWED_USER_IDS is None or user_id in ALLOWED_USER_IDS


def guess_filename_from_url(url: str) -> str:
    path = unquote(urlparse(url).path)
    name = os.path.basename(path) or f"video_{uuid.uuid4().hex[:8]}"
    if "." not in name:
        name += ".mp4"
    return name


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


async def run_cmd(*args) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out = await proc.stdout.read()
    await proc.wait()
    return proc.returncode, out.decode(errors="ignore")


async def get_duration_seconds(path: Path) -> float:
    code, out = await run_cmd(
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "csv=p=0", str(path),
    )
    try:
        return float(out.strip())
    except ValueError:
        return 0.0


# ---------------------------------------------------------------------------
# کیبورد تنظیمات یک کار
# ---------------------------------------------------------------------------
def build_settings_keyboard(job: Job) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()

    mkv_label = ("✅ " if job.mode == "mkv" else "") + "🎬 تبدیل به mkv"
    orig_label = ("✅ " if job.mode == "original" else "") + "📦 فرمت اصلی"
    kb.row(
        InlineKeyboardButton(text=mkv_label, callback_data=f"m:{job.job_id}:mkv"),
        InlineKeyboardButton(text=orig_label, callback_data=f"m:{job.job_id}:orig"),
    )

    default_label = ("✅ " if job.preset == "default" else "") + "⚙️ پیش‌فرض"
    manual_label = ("✅ " if job.preset == "manual" else "") + "🛠 دستی"
    kb.row(
        InlineKeyboardButton(text=default_label, callback_data=f"p:{job.job_id}:default"),
        InlineKeyboardButton(text=manual_label, callback_data=f"p:{job.job_id}:manual"),
    )

    if job.preset == "manual":
        dim_text = f"📐 حداکثر ابعاد: {job.max_dim}px" if job.max_dim else "📐 حداکثر ابعاد: تغییر نکن"
        crf_text = f"🎚 CRF: {job.crf}"
        kb.row(
            InlineKeyboardButton(text=dim_text, callback_data=f"d:{job.job_id}"),
            InlineKeyboardButton(text=crf_text, callback_data=f"c:{job.job_id}"),
        )

    kb.row(InlineKeyboardButton(text="🚀 شروع", callback_data=f"s:{job.job_id}"))
    return kb.as_markup()


def build_cancel_keyboard(job_id: str) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    kb.row(InlineKeyboardButton(text="❌ لغو", callback_data=f"x:{job_id}"))
    return kb.as_markup()


def settings_card_text(job: Job) -> str:
    return f"⚙️ تنظیمات پردازش برای:\n{job.filename}\n\nبعد از انتخاب گزینه‌ها روی 🚀 شروع بزن."


# ---------------------------------------------------------------------------
# کیبورد تنظیمات سراسری (/settings)
# ---------------------------------------------------------------------------
def global_settings_text() -> str:
    dim_text = f"{settings.default_max_dim}px" if settings.default_max_dim else "تغییر نکن"
    return (
        "⚙️ تنظیمات پیش‌فرض ربات\n"
        "(همینی که برای هر کار جدید توی حالت «پیش‌فرض» استفاده می‌شه)\n\n"
        f"فرمت پیش‌فرض: {'mkv' if settings.default_mode == 'mkv' else 'فرمت اصلی'}\n"
        f"حداکثر ابعاد پیش‌فرض: {dim_text}\n"
        f"CRF پیش‌فرض: {settings.default_crf}"
    )


def build_global_settings_keyboard() -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    mkv_label = ("✅ " if settings.default_mode == "mkv" else "") + "🎬 mkv"
    orig_label = ("✅ " if settings.default_mode == "original" else "") + "📦 فرمت اصلی"
    kb.row(
        InlineKeyboardButton(text=mkv_label, callback_data="gm:mkv"),
        InlineKeyboardButton(text=orig_label, callback_data="gm:orig"),
    )
    dim_text = f"📐 ابعاد: {settings.default_max_dim}px" if settings.default_max_dim else "📐 ابعاد: تغییر نکن"
    crf_text = f"🎚 CRF: {settings.default_crf}"
    kb.row(
        InlineKeyboardButton(text=dim_text, callback_data="gd"),
        InlineKeyboardButton(text=crf_text, callback_data="gc"),
    )
    kb.row(InlineKeyboardButton(text="♻️ ابعاد را روی «تغییر نکن» برگردان", callback_data="gdreset"))
    return kb.as_markup()


# ---------------------------------------------------------------------------
# ساخت جاب جدید (از لینک یا فایل)
# ---------------------------------------------------------------------------
async def create_job_from_message(message: Message, source_type: str, filename: str,
                                   url: Optional[str] = None, tg_file_id: Optional[str] = None) -> None:
    job_id = uuid.uuid4().hex[:8]
    job = Job(
        job_id=job_id,
        chat_id=message.chat.id,
        user_id=message.from_user.id,
        source_type=source_type,
        filename=filename,
        url=url,
        tg_file_id=tg_file_id,
    )
    jobs[job_id] = job
    sent = await message.reply(settings_card_text(job), reply_markup=build_settings_keyboard(job))
    job.settings_msg_id = sent.message_id


# ---------------------------------------------------------------------------
# دانلود
# ---------------------------------------------------------------------------
async def download_url(job: Job, dest_dir: Path, filename: str, status_cb) -> Path:
    dest = dest_dir / filename
    cmd = [
        "aria2c", "-x", "16", "-s", "16", "-k", "1M",
        "--max-tries=3", "--allow-overwrite=true",
        "--dir", str(dest_dir), "--out", filename, job.url,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    job.current_proc = proc
    last_update = 0.0
    async for line in proc.stdout:
        if job.cancelled:
            proc.terminate()
            await proc.wait()
            raise JobCancelled()
        text = line.decode(errors="ignore")
        now = time.monotonic()
        if now - last_update > 5 and "%" in text:
            last_update = now
            await status_cb(f"⬇️ در حال دانلود...\n{text.strip()[-200:]}")
    await proc.wait()
    if job.cancelled:
        raise JobCancelled()
    if proc.returncode != 0 or not dest.exists():
        raise RuntimeError("دانلود فایل ناموفق بود.")
    return dest


async def download_tg_file(job: Job, dest_dir: Path, filename: str, status_cb) -> Path:
    dest = dest_dir / filename
    await status_cb("⬇️ در حال دریافت فایل از تلگرام...")
    await bot.download(job.tg_file_id, destination=str(dest))
    if job.cancelled:
        raise JobCancelled()
    if not dest.exists():
        raise RuntimeError("دریافت فایل از تلگرام ناموفق بود.")
    return dest


# ---------------------------------------------------------------------------
# تبدیل با ffmpeg
# ---------------------------------------------------------------------------
def build_scale_filter(max_dim: int) -> str:
    return (
        f"scale=w='if(gt(iw,ih),min(iw,{max_dim}),-2)':"
        f"h='if(gt(iw,ih),-2,min(ih,{max_dim}))'"
    )


async def convert(job: Job, src: Path, dst: Path, status_cb) -> None:
    duration = await get_duration_seconds(src)

    if job.preset == "manual":
        crf = str(job.crf)
        max_dim = job.max_dim
    else:
        # حالت پیش‌فرض همیشه از آخرین تنظیمات سراسری استفاده می‌کنه
        crf = str(settings.default_crf)
        max_dim = settings.default_max_dim

    cmd = [
        "ffmpeg", "-y",
        "-noautorotate",
        "-i", str(src),
        "-map", "0", "-map", "-0:s", "-map", "-0:d",
    ]
    if max_dim:
        cmd += ["-vf", build_scale_filter(max_dim)]
    cmd += [
        "-c:v", "libx264", "-crf", crf, "-preset", FFMPEG_PRESET,
        "-c:a", "aac", "-b:a", FFMPEG_AUDIO_BITRATE,
        "-progress", "pipe:1", "-nostats",
        str(dst),
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
    )
    job.current_proc = proc
    last_update = 0.0
    async for raw in proc.stdout:
        if job.cancelled:
            proc.terminate()
            await proc.wait()
            raise JobCancelled()
        line = raw.decode(errors="ignore").strip()
        if line.startswith("out_time_ms="):
            try:
                out_ms = int(line.split("=")[1])
                now = time.monotonic()
                if duration > 0 and now - last_update > 10:
                    last_update = now
                    pct = min(99, out_ms / 1_000_000 / duration * 100)
                    await status_cb(f"🎬 در حال تبدیل... {pct:.0f}%")
            except (ValueError, IndexError):
                pass
    await proc.wait()
    if job.cancelled:
        raise JobCancelled()
    if proc.returncode != 0 or not dst.exists():
        raise RuntimeError("تبدیل ویدیو با ffmpeg شکست خورد.")


# ---------------------------------------------------------------------------
# پردازش یک جاب
# ---------------------------------------------------------------------------
async def process_job(job: Job) -> None:
    if job.cancelled:
        jobs.pop(job.job_id, None)
        return

    job_dir = WORK_DIR / job.job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    last_text = [""]

    async def status_cb(text: str):
        if job.cancelled:
            return
        if text != last_text[0]:
            last_text[0] = text
            try:
                await bot.edit_message_text(
                    chat_id=job.chat_id, message_id=job.settings_msg_id,
                    text=text, reply_markup=build_cancel_keyboard(job.job_id),
                )
            except Exception:
                pass

    try:
        await status_cb("⏳ شروع پردازش...")

        if job.source_type == "url":
            src_path = await download_url(job, job_dir, job.filename, status_cb)
        else:
            src_path = await download_tg_file(job, job_dir, job.filename, status_cb)

        src_size = src_path.stat().st_size
        await status_cb(f"⬇️ دانلود کامل شد ({human_size(src_size)})\n🎬 شروع تبدیل...")

        if job.mode == "mkv":
            out_ext = ".mkv"
        else:
            out_ext = Path(job.filename).suffix or ".mp4"
        dst_path = job_dir / (Path(job.filename).stem + "_compressed" + out_ext)

        await convert(job, src_path, dst_path, status_cb)

        dst_size = dst_path.stat().st_size
        await status_cb(
            f"📤 در حال آپلود...\nحجم اولیه: {human_size(src_size)}\n"
            f"حجم نهایی: {human_size(dst_size)}"
        )

        await bot.send_document(
            chat_id=job.chat_id,
            document=FSInputFile(str(dst_path)),
            caption=(
                f"✅ تمام شد\n"
                f"حجم اولیه: {human_size(src_size)} → حجم نهایی: {human_size(dst_size)}"
            ),
        )
        try:
            await bot.delete_message(chat_id=job.chat_id, message_id=job.settings_msg_id)
        except Exception:
            pass

    except JobCancelled:
        try:
            await bot.edit_message_text(
                chat_id=job.chat_id, message_id=job.settings_msg_id, text="❌ لغو شد."
            )
        except Exception:
            pass
    except Exception as e:
        log.exception("job failed")
        try:
            await bot.edit_message_text(
                chat_id=job.chat_id, message_id=job.settings_msg_id, text=f"❌ خطا: {e}"
            )
        except Exception:
            pass
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)
        jobs.pop(job.job_id, None)


async def worker():
    global current_job_id
    while True:
        job_id = await job_queue.get()
        if job_id in queued_order:
            queued_order.remove(job_id)
        current_job_id = job_id
        job = jobs.get(job_id)
        if job is not None:
            await process_job(job)
        current_job_id = None
        job_queue.task_done()


async def cancel_job(job_id: str) -> None:
    job = jobs.get(job_id)
    if job is None:
        return
    job.cancelled = True
    if job_id in queued_order:
        queued_order.remove(job_id)
    if job.current_proc is not None:
        try:
            job.current_proc.terminate()
        except Exception:
            pass
    if job_id != current_job_id:
        # کاری که هنوز پردازشش شروع نشده و فقط توی صف بوده
        try:
            await bot.edit_message_text(
                chat_id=job.chat_id, message_id=job.settings_msg_id, text="❌ لغو شد."
            )
        except Exception:
            pass
        jobs.pop(job_id, None)
    # اگر همین الان در حال پردازشه، حلقه‌ی دانلود/تبدیل خودش JobCancelled
    # می‌گیره و پیام رو مناسب آپدیت می‌کنه.


# ---------------------------------------------------------------------------
# هندلرهای دستورها
# ---------------------------------------------------------------------------
@dp.message(CommandStart())
async def start_handler(message: Message):
    await message.answer(
        "سلام 👋\n"
        "لینک مستقیم یا خودِ فایل ویدیو رو بفرست. بعدش یه کارت تنظیمات میاد، "
        "فرمت و کیفیت رو انتخاب کن و بزن 🚀 شروع.\n\n"
        "دستورهای دیگه:\n"
        "/settings — تغییر پیش‌فرض‌های ربات (بدون نیاز به ویرایش کد)\n"
        "/queue — دیدن صف پردازش و لغو تکی یا همه"
    )


@dp.message(Command("settings"))
async def settings_command(message: Message):
    if not is_allowed(message.from_user.id):
        await message.answer("متاسفانه اجازه تغییر تنظیمات رو نداری.")
        return
    await message.answer(global_settings_text(), reply_markup=build_global_settings_keyboard())


@dp.message(Command("queue"))
async def queue_command(message: Message):
    if not is_allowed(message.from_user.id):
        return

    lines = ["📋 صف پردازش:"]
    kb = InlineKeyboardBuilder()
    any_jobs = False

    if current_job_id and current_job_id in jobs:
        j = jobs[current_job_id]
        lines.append(f"🔄 در حال پردازش: {j.filename}")
        kb.row(InlineKeyboardButton(text=f"❌ لغو: {j.filename[:24]}", callback_data=f"qx:{j.job_id}"))
        any_jobs = True

    for i, jid in enumerate(queued_order, start=1):
        j = jobs.get(jid)
        if not j:
            continue
        lines.append(f"{i}. ⏳ {j.filename}")
        kb.row(InlineKeyboardButton(text=f"❌ لغو: {j.filename[:24]}", callback_data=f"qx:{jid}"))
        any_jobs = True

    if not any_jobs:
        await message.answer("صف خالیه، هیچ پردازشی در جریان نیست.")
        return

    kb.row(InlineKeyboardButton(text="🗑 لغو همه", callback_data="qxall"))
    await message.answer("\n".join(lines), reply_markup=kb.as_markup())


# ---------------------------------------------------------------------------
# هندلرهای پیام
# ---------------------------------------------------------------------------
@dp.message(F.text.regexp(URL_RE.pattern))
async def link_handler(message: Message):
    if not is_allowed(message.from_user.id):
        await message.answer("متاسفانه اجازه استفاده از این بات رو نداری.")
        return

    if message.from_user.id in awaiting_input:
        await handle_awaiting_input(message)
        return

    match = URL_RE.search(message.text)
    if not match:
        return
    url = match.group(0)
    filename = guess_filename_from_url(url)
    await create_job_from_message(message, "url", filename, url=url)


@dp.message(F.video | F.document)
async def file_handler(message: Message):
    if not is_allowed(message.from_user.id):
        await message.answer("متاسفانه اجازه استفاده از این بات رو نداری.")
        return

    media = message.video or message.document
    filename = getattr(media, "file_name", None)
    if not filename:
        filename = f"video_{uuid.uuid4().hex[:8]}.mp4"

    if message.document and Path(filename).suffix.lower() not in VIDEO_EXTS:
        await message.reply("این فایل ویدیو به نظر نمی‌رسه.")
        return

    await create_job_from_message(message, "file", filename, tg_file_id=media.file_id)


async def handle_awaiting_input(message: Message) -> None:
    job_id, field_name = awaiting_input.pop(message.from_user.id)
    text = (message.text or "").strip()
    try:
        value = int(text)
    except ValueError:
        await message.reply("لطفاً فقط عدد بفرست.")
        awaiting_input[message.from_user.id] = (job_id, field_name)
        return

    # --- تنظیمات سراسری ---
    if job_id == "__global__":
        if field_name == "g_max_dim":
            if value == 0:
                settings.default_max_dim = None
            elif MIN_DIM <= value <= MAX_DIM_LIMIT:
                settings.default_max_dim = value
            else:
                await message.reply(f"عدد باید بین {MIN_DIM} تا {MAX_DIM_LIMIT} باشه (یا 0 برای غیرفعال کردن).")
                awaiting_input[message.from_user.id] = (job_id, field_name)
                return
        elif field_name == "g_crf":
            if not (MIN_CRF <= value <= MAX_CRF):
                await message.reply(f"CRF باید بین {MIN_CRF} تا {MAX_CRF} باشه.")
                awaiting_input[message.from_user.id] = (job_id, field_name)
                return
            settings.default_crf = value
        save_settings()
        try:
            await message.delete()
        except Exception:
            pass
        await message.answer(global_settings_text(), reply_markup=build_global_settings_keyboard())
        return

    # --- تنظیمات یک کار خاص ---
    job = jobs.get(job_id)
    if job is None:
        return

    if field_name == "max_dim":
        if not (MIN_DIM <= value <= MAX_DIM_LIMIT):
            await message.reply(f"عدد باید بین {MIN_DIM} تا {MAX_DIM_LIMIT} باشه.")
            awaiting_input[message.from_user.id] = (job_id, field_name)
            return
        job.max_dim = value
    elif field_name == "crf":
        if not (MIN_CRF <= value <= MAX_CRF):
            await message.reply(f"CRF باید بین {MIN_CRF} تا {MAX_CRF} باشه.")
            awaiting_input[message.from_user.id] = (job_id, field_name)
            return
        job.crf = value

    try:
        await message.delete()
    except Exception:
        pass

    try:
        await bot.edit_message_text(
            chat_id=job.chat_id, message_id=job.settings_msg_id,
            text=settings_card_text(job), reply_markup=build_settings_keyboard(job),
        )
    except Exception:
        pass


@dp.message()
async def fallback_handler(message: Message):
    if message.from_user.id in awaiting_input:
        await handle_awaiting_input(message)
        return
    await message.answer("یک لینک مستقیم یا فایل ویدیو برام بفرست. (یا /settings و /queue رو امتحان کن)")


# ---------------------------------------------------------------------------
# هندلرهای کالبک - کارت هر ویدیو
# ---------------------------------------------------------------------------
@dp.callback_query(F.data.startswith("m:"))
async def cb_set_mode(call: CallbackQuery):
    _, job_id, value = call.data.split(":")
    job = jobs.get(job_id)
    if job is None:
        await call.answer("این کارت منقضی شده.", show_alert=True)
        return
    job.mode = "mkv" if value == "mkv" else "original"
    await call.message.edit_text(settings_card_text(job), reply_markup=build_settings_keyboard(job))
    await call.answer()


@dp.callback_query(F.data.startswith("p:"))
async def cb_set_preset(call: CallbackQuery):
    _, job_id, value = call.data.split(":")
    job = jobs.get(job_id)
    if job is None:
        await call.answer("این کارت منقضی شده.", show_alert=True)
        return
    job.preset = "manual" if value == "manual" else "default"
    await call.message.edit_text(settings_card_text(job), reply_markup=build_settings_keyboard(job))
    await call.answer()


@dp.callback_query(F.data.startswith("d:"))
async def cb_ask_dim(call: CallbackQuery):
    _, job_id = call.data.split(":")
    job = jobs.get(job_id)
    if job is None:
        await call.answer("این کارت منقضی شده.", show_alert=True)
        return
    awaiting_input[call.from_user.id] = (job_id, "max_dim")
    await call.answer("عدد حداکثر ابعاد رو (مثلاً 1280) به‌صورت پیام بفرست.", show_alert=True)


@dp.callback_query(F.data.startswith("c:"))
async def cb_ask_crf(call: CallbackQuery):
    _, job_id = call.data.split(":")
    job = jobs.get(job_id)
    if job is None:
        await call.answer("این کارت منقضی شده.", show_alert=True)
        return
    awaiting_input[call.from_user.id] = (job_id, "crf")
    await call.answer(f"عدد CRF رو (بین {MIN_CRF} تا {MAX_CRF}) به‌صورت پیام بفرست.", show_alert=True)


@dp.callback_query(F.data.startswith("s:"))
async def cb_start(call: CallbackQuery):
    _, job_id = call.data.split(":")
    job = jobs.get(job_id)
    if job is None:
        await call.answer("این کارت منقضی شده.", show_alert=True)
        return
    position = job_queue.qsize()
    queued_order.append(job_id)
    await job_queue.put(job_id)
    text = "⏳ در صف قرار گرفت..." if position == 0 else f"⏳ در صف قرار گرفت (نوبت {position + 1})"
    await call.message.edit_text(text, reply_markup=build_cancel_keyboard(job_id))
    await call.answer()


@dp.callback_query(F.data.startswith("x:"))
async def cb_cancel(call: CallbackQuery):
    _, job_id = call.data.split(":")
    if job_id not in jobs:
        await call.answer("این کارت منقضی شده.", show_alert=True)
        return
    await cancel_job(job_id)
    await call.answer("در حال لغو...")


# ---------------------------------------------------------------------------
# هندلرهای کالبک - تنظیمات سراسری
# ---------------------------------------------------------------------------
@dp.callback_query(F.data.startswith("gm:"))
async def cb_global_mode(call: CallbackQuery):
    if not is_allowed(call.from_user.id):
        await call.answer("اجازه نداری.", show_alert=True)
        return
    _, value = call.data.split(":")
    settings.default_mode = "mkv" if value == "mkv" else "original"
    save_settings()
    await call.message.edit_text(global_settings_text(), reply_markup=build_global_settings_keyboard())
    await call.answer("ذخیره شد.")


@dp.callback_query(F.data == "gd")
async def cb_global_ask_dim(call: CallbackQuery):
    if not is_allowed(call.from_user.id):
        await call.answer("اجازه نداری.", show_alert=True)
        return
    awaiting_input[call.from_user.id] = ("__global__", "g_max_dim")
    await call.answer("عدد حداکثر ابعاد پیش‌فرض رو بفرست (یا 0 برای غیرفعال کردن).", show_alert=True)


@dp.callback_query(F.data == "gc")
async def cb_global_ask_crf(call: CallbackQuery):
    if not is_allowed(call.from_user.id):
        await call.answer("اجازه نداری.", show_alert=True)
        return
    awaiting_input[call.from_user.id] = ("__global__", "g_crf")
    await call.answer(f"عدد CRF پیش‌فرض رو (بین {MIN_CRF} تا {MAX_CRF}) بفرست.", show_alert=True)


@dp.callback_query(F.data == "gdreset")
async def cb_global_reset_dim(call: CallbackQuery):
    if not is_allowed(call.from_user.id):
        await call.answer("اجازه نداری.", show_alert=True)
        return
    settings.default_max_dim = None
    save_settings()
    await call.message.edit_text(global_settings_text(), reply_markup=build_global_settings_keyboard())
    await call.answer("بازنشانی شد.")


# ---------------------------------------------------------------------------
# هندلرهای کالبک - /queue
# ---------------------------------------------------------------------------
@dp.callback_query(F.data.startswith("qx:"))
async def cb_queue_cancel(call: CallbackQuery):
    if not is_allowed(call.from_user.id):
        await call.answer("اجازه نداری.", show_alert=True)
        return
    _, job_id = call.data.split(":")
    await cancel_job(job_id)
    await call.answer("لغو شد.")


@dp.callback_query(F.data == "qxall")
async def cb_queue_cancel_all(call: CallbackQuery):
    if not is_allowed(call.from_user.id):
        await call.answer("اجازه نداری.", show_alert=True)
        return
    ids = list(queued_order)
    if current_job_id:
        ids.append(current_job_id)
    for jid in ids:
        await cancel_job(jid)
    await call.answer("همه لغو شدن.")


# ---------------------------------------------------------------------------
# وب‌سرور سبک برای health-check / keep-alive
# ---------------------------------------------------------------------------
async def health(request):
    return web.Response(text="OK")


async def run_http_server():
    app = web.Application()
    app.router.add_get("/", health)
    app.router.add_get("/health", health)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", HTTP_PORT)
    await site.start()
    log.info("HTTP health server listening on :%s", HTTP_PORT)


async def main():
    asyncio.create_task(worker())
    await run_http_server()
    log.info("Bot polling started")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
