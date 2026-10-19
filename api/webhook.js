require('dotenv').config(); // Memuat environment variabel dari file .env
const { Telegraf } = require('telegraf');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

// Mengambil token bot dari Environment Variable
const bot = new Telegraf(process.env.BOT_TOKEN);

// Fungsi jeda untuk menghindari Rate Limit Telegram (maksimal 1 pesan/detik)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// === BRANKAS MEMORI SESI ===
// Menyimpan sementara nomor yang belum dikirim agar bisa dilanjutkan dengan tombol
const userSessions = {};

// === SATPAM KEAMANAN (MIDDLEWARE) ===
bot.use(async (ctx, next) => {
    // Abaikan interaksi sistem internal Telegram yang tidak memiliki data pengirim
    if (!ctx.from) return next();

    // Mengambil daftar ID yang diizinkan dari Vercel
    const allowedIdsStr = process.env.ADMIN_IDS || "";
    // Membersihkan spasi dan memecah daftar ID jika ada lebih dari satu
    const allowedIds = allowedIdsStr.split(',').map(id => id.trim());

    // Mengecek apakah ID pengguna saat ini ada di dalam daftar putih (Whitelist)
    const userId = ctx.from.id.toString();
    
    if (allowedIds.includes(userId)) {
        // ID dikenali, persilakan bot memproses data lebih lanjut
        return next(); 
    } else {
        // ID penyusup, tolak akses dan jangan teruskan ke otak penyaring
        try {
            await ctx.reply("⛔ Maaf, bot ini bersifat privat. Anda tidak memiliki otorisasi untuk menggunakan layanan ini.");
        } catch (error) {
            // Abaikan jika penyusup memblokir bot
        }
        return; 
    }
});

// FUNGSI UTAMA PENYARING: Memproses teks mentah (dari chat maupun file)
async function processRawText(ctx, userId, text) {
    const results = [];
    const regionNamesInIndonesian = new Intl.DisplayNames(['id'], { type: 'region' });

    const lines = text.split(/\r?\n/);

    for (const line of lines) {
        const phoneRegex = /(?:(?:\+|00)\s*)?\d[\d\s-]{8,20}/;
        const phoneMatch = line.match(phoneRegex);

        if (phoneMatch) {
            let rawNumber = phoneMatch[0];
            let cleanNumber = rawNumber.replace(/[\s-]/g, '');

            if (cleanNumber.startsWith('00')) {
                cleanNumber = '+' + cleanNumber.substring(2);
            }
            if (!cleanNumber.startsWith('+')) {
                cleanNumber = '+' + cleanNumber;
            }

            let country = 'Tidak Diketahui';

            const phoneNumber = parsePhoneNumberFromString(cleanNumber);
            if (phoneNumber && phoneNumber.isValid()) {
                try {
                    country = regionNamesInIndonesian.of(phoneNumber.country);
                } catch (e) {
                    country = phoneNumber.country || 'Tidak Diketahui';
                }
                cleanNumber = phoneNumber.number;
            } else {
                const countryRegex = /\((.*?)\)/;
                const countryMatch = line.match(countryRegex);
                if (countryMatch) {
                    country = countryMatch[1].trim();
                }
            }

            results.push({ number: cleanNumber, country });
        }
    }

    if (results.length === 0) {
        return ctx.reply("Saya tidak menemukan format nomor telepon yang valid.");
    }

    // SIMPAN SEMUA DATA KE MEMORI
    userSessions[userId] = {
        data: results,
        currentIndex: 0
    };

    // Mulai kirim batch pertama
    await processBatch(ctx, userId);
}

// INDRA TEKS: Menangani ketikan/paste teks biasa
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const userId = ctx.from.id;

    if (text.length < 5 || text.startsWith('/')) {
        if (text === '/start') {
            return ctx.reply("Halo! Kirimkan teks atau file berformat .txt berisi daftar nomor telepon, saya akan menyaring dan memprosesnya.");
        }
        return;
    }

    await processRawText(ctx, userId, text);
});

// INDRA DOKUMEN: Menangani kiriman file .txt
bot.on('document', async (ctx) => {
    const document = ctx.message.document;
    const userId = ctx.from.id;

    // Cek apakah file benar-benar file teks
    if (document.mime_type !== 'text/plain' && !document.file_name.endsWith('.txt')) {
        return ctx.reply("Mohon maaf, saya hanya bisa membaca file berformat .txt");
    }

    // Batasi ukuran file (misal maksimal 5MB agar aman di memori Vercel)
    if (document.file_size > 5 * 1024 * 1024) {
        return ctx.reply("Ukuran file terlalu besar. Maksimal 5MB.");
    }

    await ctx.reply("📥 Mengunduh dan membaca file .txt Anda...");

    try {
        // Meminta tautan file dari server Telegram
        const fileLink = await ctx.telegram.getFileLink(document.file_id);
        
        // Membaca isi file secara instan menggunakan fitur bawaan Node.js (fetch)
        const response = await fetch(fileLink.href);
        const text = await response.text();

        // Melemparkan isi teks dari file ke dalam otak penyaring utama
        await processRawText(ctx, userId, text);
    } catch (error) {
        console.error("Gagal memproses file:", error);
        ctx.reply("Terjadi kesalahan saat membaca file. Pastikan file tidak rusak atau kosong.");
    }
});

// FUNGSI BARU: Mengirim nomor bertahap per 30 data
async function processBatch(ctx, userId) {
    const session = userSessions[userId];
    if (!session) return;

    const allResults = session.data;
    const startIndex = session.currentIndex;
    const limit = 30; // Batas maksimal per sesi yang Anda minta
    const endIndex = Math.min(startIndex + limit, allResults.length);
    
    const batchToProcess = allResults.slice(startIndex, endIndex);
    const isFinished = endIndex >= allResults.length;

    await ctx.reply(`Memproses nomor urutan ${startIndex + 1} hingga ${endIndex} (Total: ${allResults.length} data)...`);

    let successCount = 0;
    const countryCount = {};

    // Kirim nomor satu per satu di batch ini
    for (const item of batchToProcess) {
        try {
            await ctx.reply(item.number);
            successCount++;
            
            // Hitung negara khusus untuk 30 nomor di sesi ini
            if (countryCount[item.country]) {
                countryCount[item.country]++;
            } else {
                countryCount[item.country] = 1;
            }

            await delay(500); 
        } catch (error) {
            console.error("Gagal mengirim pesan:", error);
        }
    }

    // Simpan titik terakhir agar nanti bisa dilanjutkan dari sini
    session.currentIndex = endIndex;

    // Buat laporan rekapan
    let summary = `Total Nomor Terkirim (Sesi Ini) : ${successCount}\nStatus : Sukses\nNegara :\n`;
    for (const [country, count] of Object.entries(countryCount)) {
        summary += `- ${country} (${count})\n`;
    }

    if (isFinished) {
        summary += `\n✅ Seluruh rangkaian nomor telah selesai diproses.`;
        delete userSessions[userId]; // Hapus memori agar bersih
        await ctx.reply(summary);
    } else {
        const sisa = allResults.length - endIndex;
        summary += `\n⚠️ Pengiriman dijeda demi keamanan sistem karena telah mencapai batas 30 nomor per sesi.`;
        
        // Memunculkan tombol Lanjut
        await ctx.reply(summary, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: `➡️ Lanjut Proses (Sisa: ${sisa} Nomor)`, callback_data: 'lanjut_proses' }
                    ]
                ]
            }
        });
    }
}

// INDRA BARU: Menangkap saat tombol "Lanjut" ditekan
bot.action('lanjut_proses', async (ctx) => {
    const userId = ctx.from.id;
    
    // Memberikan sinyal ke Telegram bahwa tombol berhasil ditekan (menghapus animasi loading)
    await ctx.answerCbQuery(); 

    // Jika Vercel sudah keburu tidur dan memori terhapus
    if (!userSessions[userId]) {
        return ctx.reply("Sesi Anda sudah kedaluwarsa karena Vercel tertidur. Silakan salin dan kirim ulang daftar sisa nomor Anda.");
    }

    // Lanjutkan pengiriman dari titik terakhir
    await processBatch(ctx, userId);
});

// Pengaturan Handler Khusus untuk Vercel Serverless
module.exports = async (req, res) => {
    try {
        // Vercel menerima webhook dari Telegram dengan metode POST
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body, res);
        } else {
            // Tampilan jika domain Vercel dibuka secara manual di browser (untuk pengecekan status)
            res.status(200).json({ 
                status: 'Bot aktif!', 
                info: 'Webhook siap menerima pembaruan dari Telegram.' 
            });
        }
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).send('Terjadi kesalahan pada server bot.');
    }
};
