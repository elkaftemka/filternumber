require('dotenv').config(); // Memuat environment variabel dari file .env
const { Telegraf } = require('telegraf');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

// Mengambil token bot dari Environment Variable
const bot = new Telegraf(process.env.BOT_TOKEN);

// Fungsi jeda untuk menghindari Rate Limit Telegram (maksimal 1 pesan/detik)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    if (text.length < 5 || text.startsWith('/')) {
        if (text === '/start') {
            return ctx.reply("Halo! Kirimkan teks berisi daftar nomor telepon, saya akan menyaring dan mengirimkannya satu per satu.");
        }
        return;
    }

    const results = [];
    const countryCount = {};
    const regionNamesInIndonesian = new Intl.DisplayNames(['id'], { type: 'region' });

    // STRATEGI BARU: Pecah pesan berdasarkan baris (Enter) terlebih dahulu
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
        // Regex ini HANYA mengekstrak deretan angka terpanjang dalam satu baris,
        // mengabaikan angka kecil seperti nomor urut list "1. ", "2. ", dst.
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

            // LAPIS 2: Deteksi dengan libphonenumber-js
            const phoneNumber = parsePhoneNumberFromString(cleanNumber);
            if (phoneNumber && phoneNumber.isValid()) {
                try {
                    country = regionNamesInIndonesian.of(phoneNumber.country);
                } catch (e) {
                    country = phoneNumber.country || 'Tidak Diketahui';
                }
                cleanNumber = phoneNumber.number;
            } else {
                // LAPIS 1: Deteksi nama negara di dalam kurung jika regex library gagal
                const countryRegex = /\((.*?)\)/;
                const countryMatch = line.match(countryRegex);
                if (countryMatch) {
                    country = countryMatch[1].trim();
                }
            }

            results.push({ number: cleanNumber, country });

            if (countryCount[country]) {
                countryCount[country]++;
            } else {
                countryCount[country] = 1;
            }
        }
    }

    if (results.length === 0) {
        return ctx.reply("Saya tidak menemukan format nomor telepon yang valid dalam pesan tersebut.");
    }

    await ctx.reply(`Memproses ${results.length} nomor secara berurutan...`);

    let successCount = 0;

    for (const data of results) {
        try {
            await ctx.reply(data.number);
            successCount++;
            await delay(500); 
        } catch (error) {
            console.error("Gagal mengirim pesan ke pengguna:", error);
        }
    }

    let summary = `Total Nomor : ${successCount}\nStatus : Sukses\nNegara :\n`;
    for (const [country, count] of Object.entries(countryCount)) {
        summary += `- ${country} (${count})\n`;
    }

    await ctx.reply(summary);
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
