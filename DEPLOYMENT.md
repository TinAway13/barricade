# Deploy Blockline with Firebase Realtime Database + Vercel

เกมเวอร์ชันนี้เป็น static HTML/CSS/JavaScript บน Vercel และใช้ Firebase โดยตรง:

- Firebase Anonymous Authentication ระบุตัวผู้เล่น
- Firebase Realtime Database ซิงก์ห้อง ผู้เล่น ตาเดิน ตัวหมาก และกำแพง
- Realtime Database transaction ป้องกันผู้เล่นสองคนเขียนสถานะห้องชนกัน
- ไม่มี Go WebSocket server และไม่มี `BLOCKLINE_WS_URL` แล้ว

## 1. สร้างและตั้งค่า Firebase

1. สร้าง Firebase project ที่ <https://console.firebase.google.com/>.
2. Project overview → Add app → Web (`</>`) แล้ว Register app.
3. Build → Realtime Database → Create Database เลือก region ที่ใกล้ผู้เล่น และเริ่มแบบ Locked mode.
4. Build → Authentication → Sign-in method → เปิด **Anonymous**.
5. Authentication → Settings → Authorized domains → เพิ่ม production domain ของ Vercel เช่น `your-game.vercel.app` และ custom domain (ถ้ามี).
6. ติดตั้ง Firebase CLI แล้ว deploy rules ในไฟล์ `database.rules.json`:

   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use --add
   firebase deploy --only database
   ```

   หรือคัดลอกเนื้อหา `database.rules.json` ไปที่ Realtime Database → Rules แล้วกด Publish.

อย่าใช้ Test mode หรือ rules ที่เป็น `.read: true, .write: true` บน production.

## 2. Firebase config ที่ต้องใช้

ไปที่ Project settings → General → Your apps → Web app → SDK setup and configuration → Config แล้วนำค่าต่อไปนี้มาใช้:

| Firebase config | Vercel Environment Variable | จำเป็น |
| --- | --- | --- |
| `apiKey` | `FIREBASE_API_KEY` | ใช่ |
| `authDomain` | `FIREBASE_AUTH_DOMAIN` | ใช่ |
| `databaseURL` | `FIREBASE_DATABASE_URL` | ใช่ |
| `projectId` | `FIREBASE_PROJECT_ID` | ใช่ |
| `appId` | `FIREBASE_APP_ID` | ใช่ |
| `storageBucket` | `FIREBASE_STORAGE_BUCKET` | ไม่จำเป็นสำหรับเกมนี้ |
| `messagingSenderId` | `FIREBASE_MESSAGING_SENDER_ID` | ไม่จำเป็นสำหรับเกมนี้ |

`databaseURL` ต้องเป็น URL ของ Realtime Database ตัวจริง เช่น:

```text
https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app
```

Firebase Web config เป็นข้อมูล public identifier ที่ถูกส่งไป browser อยู่แล้ว ความปลอดภัยต้องมาจาก Authentication และ Database Rules ห้ามนำ service-account JSON, `private_key`, refresh token หรือ Firebase Admin credentials ใส่ใน frontend หรือส่งให้ผู้อื่น.

## 3. ตั้งค่า Vercel

1. Import repository เข้า Vercel.
2. Project Settings → Build and Deployment:
   - Framework Preset: **Other**
   - Build Command: ใช้ค่าจาก `vercel.json` (`node scripts/build-vercel.cjs`)
   - Output Directory: ใช้ค่าจาก `vercel.json` (`dist`)
3. Project Settings → Environment Variables เพิ่มตัวแปร Firebase ตามตารางด้านบน.
4. เลือก Environment อย่างน้อย **Production** และ **Preview** (Development ด้วยถ้าใช้ `vercel dev`).
5. Redeploy หลังเพิ่มหรือแก้ environment variables เพราะค่าใหม่ไม่มีผลกับ deployment เก่า.

Build script จะหยุด deploy ทันทีหากตัวแปรที่จำเป็นขาด และจะฝังเฉพาะ Firebase Web config ลงใน `dist/index.html`.

## 4. ทดสอบ build ก่อน deploy

ตั้งค่าตัวแปรตาม `.env.example` แล้วรัน:

```bash
node scripts/build-vercel.cjs
```

จากนั้น serve โฟลเดอร์ `dist` ด้วย static server ห้ามเปิด `example.html` ตรงผ่าน `file://` เพราะ Firebase Auth ต้องทำงานบน authorized web origin.

## Security note

Rules ที่ให้มาบังคับให้ผู้ใช้ sign in แบบ anonymous, จำกัดโครงสร้างข้อมูล/จำนวนผู้เล่น/ขอบเขตพิกัด และอนุญาตเขียนเฉพาะสมาชิกห้อง อย่างไรก็ตามกติกากระดานที่ซับซ้อนถูกตรวจใน transaction ฝั่ง client ดังนั้นผู้ใช้ที่แก้ JavaScript ผ่าน DevTools ยังอาจพยายามโกงได้ ถ้าต้องการ ranked/competitive mode ให้ย้ายการตรวจ move และ wall ไป Firebase Cloud Functions หรือ trusted server แล้วปิดสิทธิ์เขียน game state โดยตรงจาก client.
