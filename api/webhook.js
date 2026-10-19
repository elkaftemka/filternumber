require('dotenv').config(); // Memuat environment variabel dari file .env
const { Telegraf } = require('telegraf');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

// Mengambil token bot dari Environment Variable
const bot = new Telegraf(process.env.BOT_TOKEN);

// Fungsi jeda untuk menghindari Rate Limit Telegram (maksimal 1 pesan/detik)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    // Abaikan pesan pendek atau perintah dasar (misal /start)
    if (text.length < 10 || text.startsWith('/')) {
        if (text === '/start') {
            return ctx.reply("Halo! Kirimkan teks berisi daftar nomor telepon, saya akan menyaring dan mengirimkannya satu per satu.");
        }
        return;
    }

    // Regex Cerdas (Revisi Anti-Beranak):
    // Memakai [ \t] sebagai ganti \s agar "Enter" (baris baru) tidak ikut tersedot.
    const regex = /((?:\+|00)?\d[\d \t-]{7,15})(?:[ \t]*\((.*?)\))?/g;
    
    let match;
    const results = [];
    const countryCount = {};

    // Fitur bawaan Node.js untuk menerjemahkan kode negara (ID, SA, UG) menjadi teks Indonesia
    const regionNamesInIndonesian = new Intl.DisplayNames(['id'], { type: 'region' });

    // Melakukan pencarian berulang pada seluruh isi teks
    while ((match = regex.exec(text)) !== null) {
        let rawNumber = match[1];
        
        // Bersihkan nomor hanya dari spasi, tab, dan tanda hubung
        let cleanNumber = rawNumber.replace(/[ \t-]/g, '');
        
        // Ubah awalan 00 menjadi + (standar format internasional)
        if (cleanNumber.startsWith('00')) {
            cleanNumber = '+' + cleanNumber.substring(2);
        }
        
        // Jika nomor murni angka (belum ada +), tambahkan + agar libphonenumber bisa menebak negaranya
        if (!cleanNumber.startsWith('+')) {
            cleanNumber = '+' + cleanNumber;
        }

        let country = 'Tidak Diketahui';

        // LAPIS 2: Coba deteksi negara menggunakan libphonenumber-js
        const phoneNumber = parsePhoneNumberFromString(cleanNumber);
        
        if (phoneNumber && phoneNumber.country) {
            try {
                // Ubah kode negara (misal 'UG') menjadi 'Uganda'
                country = regionNamesInIndonesian.of(phoneNumber.country);
            } catch (e) {
                country = phoneNumber.country;
            }
            // Rapikan format nomor menjadi standar baku +E.164 (misal: +256779011141)
            cleanNumber = phoneNumber.number; 
        } else if (match[2]) {
            // LAPIS 1: Jika deteksi otomatis gagal, ambil nama negara dari teks di dalam kurung (jika ada)
            country = match[2].trim();
        }

        results.push({ number: cleanNumber, country });

        // Menghitung jumlah masing-masing negara untuk rekapan akhir
        if (countryCount[country]) {
            countryCount[country]++;
        } else {
            countryCount[country] = 1;
        }
    }

    // Jika tidak ada nomor yang ditemukan sama sekali
    if (results.length === 0) {
        return ctx.reply("Saya tidak menemukan format nomor telepon yang valid dalam pesan tersebut.");
    }

    // Mengirim notifikasi awal bahwa bot mulai bekerja
    await ctx.reply(`Memproses ${results.length} nomor secara berurutan...`);

    let successCount = 0;

    // Loop untuk mengirim nomor satu per satu
    for (const data of results) {
        try {
            await ctx.reply(data.number);
            successCount++;
            
            // Jeda diubah menjadi 0.5 detik agar pengiriman lebih cepat
            await delay(500); 
        } catch (error) {
            console.error("Gagal mengirim pesan ke pengguna:", error);
        }
    }

    // Membuat teks rekapan akhir yang dinamis sesuai dengan negara yang terdeteksi
    let summary = `Total Nomor : ${successCount}\nStatus : Sukses\nNegara :\n`;
    for (const [country, count] of Object.entries(countryCount)) {
        summary += `- ${country} (${count})\n`;
    }

    // Mengirim rekapan akhir
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
