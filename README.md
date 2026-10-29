# ULTRA BET — Telegram ID Approval

ဒီ project သည် `index.html` သို့မဟုတ် `user.html` မှ ဝင်သုံးသည့် ULTRA BET user app ဖြစ်သည်။ Admin အတွက် web panel မသုံးပါ။ User login မှရလာသော platform token ကို server က သတ်မှတ်ထားသည့် `GetUserInfo` API မှတစ်ဆင့် ပြန်လည်စစ်ဆေးပြီး၊ server က အတည်ပြုရရှိသည့် Account ID ကိုသာ Telegram approval သို့ ပို့သည်။

အုပ်ချုပ်သူက Telegram private chat ထဲရှိ `ခွင့်ပြုမည်` / `ပယ်ချမည်` ခလုတ်ကိုနှိပ်သည်။ ခွင့်ပြုထားသော `(platform, accountId)` ကို Managed MySQL တွင် သိမ်းထားသဖြင့် နောက်တစ်ကြိမ် login တိုင်း server က platform ID ကို ပြန်စစ်ပြီး ယခင်ခွင့်ပြုချက်ကို အသုံးပြုသည်။ Password နှင့် platform token ကို Telegram၊ Managed MySQL သို့မဟုတ် server log တွင် မသိမ်းပါ။

Approval ပြီးလျှင် server က သက်တမ်း ၁၂ နာရီရှိသော HttpOnly session cookie ပေးသည်။ Database တွင် raw session နှင့် CSRF token မဟုတ်ဘဲ hash များကိုသာ သိမ်းသည်။ Live Chat သည် server session ထဲက identity ကိုသာ အသုံးပြုပြီး message အသစ်ကို Managed MySQL ထဲသို့သိမ်းသည်။

Firebase SDK/config/API နှင့် `admin.html` ကို ဖယ်ရှားထားသည်။ Firebase ၏ အဟောင်း approval စာရင်းနှင့် chat history ကို မဖတ်၊ မတင်ပို့၊ မတင်သွင်းပါ။ အရင်က ခွင့်ပြုထားသူအပါအဝင် user တိုင်းသည် Telegram မှတစ်ကြိမ် အသစ် approve ရယူရမည်။ Firebase အရင်းအမြစ်နှင့် သီးခြား secrets များကို မပြောင်းလဲပါ။

## အဓိကဖိုင်များ

- `index.html`, `user.html` — Burmese user app နှင့် approval dialog။
- `public/ultra-ui.css`, `public/ultra-mark.svg` — စာမျက်နှာနှစ်ခုလုံးအတွက် shared UI design နှင့် ULTRA mark။
- `client-services.js` — server approval/session နှင့် CSRF-protected Live Chat client။
- `server.js` — platform ID verification, MySQL migration/API, session, Telegram polling/callback နှင့် static serving။
- `TELEGRAM_APPROVAL_SETUP.md` — protected settings, `/start`, webhook/polling နှင့် Managed MySQL လမ်းညွှန်။
- `plan.md`, `TODO.md` — architecture ဆုံးဖြတ်ချက်နှင့် လုပ်ဆောင်မှုအခြေအနေ။

## လိုအပ်သော server environment

- `DATABASE_URL` — WebDev Managed MySQL က ပေးသော DSN။
- `TELEGRAM_BOT_TOKEN` — Telegram BotFather token; protected server secret အဖြစ်သာထားရန်။
- `TELEGRAM_ADMIN_USER_ID` — ခွင့်ပြုထားသော admin ၏ numeric Telegram user ID; protected server secret အဖြစ်သာထားရန်။
- `PORT` — runtime က ပေးသော port; default သည် `3000` ဖြစ်သည်။
- `SESSION_COOKIE_SECURE` — ပုံမှန်အားဖြင့် မထည့်ပါနှင့်; HTTPS Preview/production အတွက် `Secure; SameSite=None` ကို default အသုံးပြုသည်။ Plain HTTP local test တစ်ခုတည်းအတွက် `false` ဟု သတ်မှတ်နိုင်သည်။

## Run

Node.js 20 နှင့်အထက်၊ npm အသုံးပြုပါ။

```sh
npm ci
npm start
```

Admin သည် bot သို့ `/start` ပို့ပြီးနောက် server ၏ `GET /api/health` မှ `databaseReady: true` နှင့် `telegramReady: true` ကိုစစ်ဆေးနိုင်သည်။ Startup တွင် server က webhook ကို ဖယ်ရှားပြီး pending updates များကို မဖျက်ဘဲ long polling စတင်သည်။ Telegram bot token တူညီသော server process တစ်ခုထက်ပို၍ တစ်ပြိုင်နက် polling မလုပ်ပါနှင့်။

2026-10-29 တွင် user က share လုပ်နိုင်သော public web link ထုတ်ရန် ခွင့်ပြုထားသည်။ Telegram/Database secret တန်ဖိုးများကို code သို့မဟုတ် browser bundle ထဲ မထည့်ပါနှင့်။ Old Firebase service-account နှင့် admin-password secrets များကို code က မသုံးသော်လည်း အလိုအလျောက်မဖျက်ပါ။
