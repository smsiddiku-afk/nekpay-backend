// NEKpay & WatchPay Payment Gateway Integration with Firebase
// -------------------------------------------------------------
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const qs = require("querystring");
const cors = require("cors");
const admin = require("firebase-admin");

// Firebase Admin ইনিশিয়ালাইজ
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.urlencoded({ extended: true }));

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---------------------------------------------------------
// 1. CONFIG
// ---------------------------------------------------------
const CONFIG = {
  MCH_ID: "808258213",
  MCH_KEY: "d3e912a25c7e4e059832173b16b9e3c9",
  PAY_TYPE: "2220",
  PAY_URL: "https://api.nekpayment.com/pay/web",
  NOTIFY_URL: "https://nekpay-backend.onrender.com/nekpay-callback",
  PAGE_URL: "https://novavest-a711c.web.app/payment-result",
};

const WATCHPAY_CONFIG = {
  MCH_ID: "955666713",
  MCH_KEY: "e3effb980e594817ba30968942af2494",
  PAY_TYPE: "2220",
  PAY_URL: "https://api.watchglb.com/pay/web",
  NOTIFY_URL: "https://nekpay-backend.onrender.com/watchpay-callback",
  PAGE_URL: "https://novavest-a711c.web.app/payment-result",
};

const orders = {};
const watchpayOrders = {};

// ---------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------
function generateSign(params, secretKey) {
  const sortedKeys = Object.keys(params)
    .filter((k) => {
      const lower = k.toLowerCase();
      return (
        params[k] !== "" &&
        params[k] !== undefined &&
        params[k] !== null &&
        lower !== "sign" &&
        lower !== "sign_type" &&
        lower !== "signtype"
      );
    })
    .sort();

  const baseString =
    sortedKeys.map((k) => `${k}=${params[k]}`).join("&") + `&key=${secretKey}`;

  return crypto.createHash("md5").update(baseString, "utf8").digest("hex");
}

function formatDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------------------------------------------------------
// 3. NEKpay: Create Order & Callback
// ---------------------------------------------------------
app.post(["/create-order", "/api/v1/nekpay/create-order"], async (req, res) => {
  try {
    const { amount, payerName, userId } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const mchOrderNo = "ORD" + Date.now();
    const orderDate = formatDate(new Date());

    const params = {
      version: "1.0",
      mch_id: CONFIG.MCH_ID,
      notify_url: CONFIG.NOTIFY_URL,
      page_url: CONFIG.PAGE_URL,
      mch_order_no: mchOrderNo,
      pay_type: CONFIG.PAY_TYPE,
      trade_amount: Number(amount).toFixed(2),
      order_date: orderDate,
      goods_name: "Deposit",
      mch_return_msg: userId || "deposit",
      payer_name: payerName || "Customer",
      sign_type: "MD5",
    };

    params.sign = generateSign(params, CONFIG.MCH_KEY);

    orders[mchOrderNo] = {
      userId: userId || null,
      amount: params.trade_amount,
      status: "pending",
      createdAt: new Date(),
    };

    await db.collection("deposits").doc(mchOrderNo).set({
      orderNo: mchOrderNo,
      userId: userId || "guest",
      amount: Number(params.trade_amount),
      status: "pending",
      gateway: "NEKpay",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const response = await axios.post(CONFIG.PAY_URL, qs.stringify(params), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const data = response.data;

    if (data.respCode === "SUCCESS" && data.tradeResult === "1") {
      return res.json({
        success: true,
        paymentLink: data.payInfo,
        orderNo: mchOrderNo,
      });
    } else {
      orders[mchOrderNo].status = "failed";
      return res.status(400).json({
        success: false,
        message: data.tradeMsg || "Order creation failed",
      });
    }
  } catch (err) {
    console.error("create-order error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/nekpay-callback", async (req, res) => {
  try {
    const body = req.body;
    console.log("Received NEKpay callback:", body);

    const expectedSign = generateSign(body, CONFIG.MCH_KEY);

    if (expectedSign !== body.sign) {
      console.warn("Signature mismatch!");
      return res.status(400).send("fail");
    }

    const { mchOrderNo, tradeResult, amount, merRetMsg } = body;

    if (tradeResult === "1") {
      const depositAmount = Number(amount);
      const targetUserId = (orders[mchOrderNo] && orders[mchOrderNo].userId) || merRetMsg;

      await db.collection("deposits").doc(mchOrderNo).set({
        orderNo: mchOrderNo,
        userId: targetUserId,
        amount: depositAmount,
        status: "success",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      if (targetUserId && targetUserId !== "guest" && targetUserId !== "deposit") {
        await db.collection("users").doc(targetUserId).update({
          balance: admin.firestore.FieldValue.increment(depositAmount)
        });
      }

      return res.status(200).send("success");
    } else {
      await db.collection("deposits").doc(mchOrderNo).update({ status: "failed" });
      return res.status(200).send("success");
    }
  } catch (err) {
    console.error("callback error:", err.message);
    return res.status(500).send("fail");
  }
});

app.get("/order-status/:orderNo", (req, res) => {
  const order = orders[req.params.orderNo];
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

// ---------------------------------------------------------
// 4. WatchPay: Create Order & Callback
// ---------------------------------------------------------
app.post("/create-order-watchpay", async (req, res) => {
  try {
    const { amount, payerName, userId } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    const mchOrderNo = "WPY" + Date.now();
    const orderDate = formatDate(new Date());

    const params = {
      version: "1.0",
      mch_id: WATCHPAY_CONFIG.MCH_ID,
      notify_url: WATCHPAY_CONFIG.NOTIFY_URL,
      page_url: WATCHPAY_CONFIG.PAGE_URL,
      mch_order_no: mchOrderNo,
      pay_type: WATCHPAY_CONFIG.PAY_TYPE,
      trade_amount: Number(amount).toFixed(2),
      order_date: orderDate,
      goods_name: "Deposit",
      mch_return_msg: userId || "deposit",
      payer_name: payerName || "Customer",
      sign_type: "MD5",
    };

    params.sign = generateSign(params, WATCHPAY_CONFIG.MCH_KEY);

    watchpayOrders[mchOrderNo] = {
      userId: userId || null,
      amount: Number(params.trade_amount),
      status: "pending",
      createdAt: new Date(),
    };

    await db.collection("deposits").doc(mchOrderNo).set({
      orderNo: mchOrderNo,
      userId: userId || "guest",
      amount: Number(params.trade_amount),
      status: "pending",
      gateway: "WatchPay",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const response = await axios.post(WATCHPAY_CONFIG.PAY_URL, qs.stringify(params), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const data = response.data;

    if (data.respCode === "SUCCESS" && data.tradeResult === "1") {
      return res.json({
        success: true,
        paymentLink: data.payInfo,
        orderNo: mchOrderNo,
      });
    } else {
      return res.status(400).json({
        success: false,
        message: data.tradeMsg || "Order creation failed",
      });
    }
  } catch (err) {
    console.error("create-order error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/watchpay-callback", async (req, res) => {
  try {
    const body = req.body;
    console.log("Received WatchPay callback:", body);

    const expectedSign = generateSign(body, WATCHPAY_CONFIG.MCH_KEY);

    if (expectedSign !== body.sign) {
      console.warn("WatchPay callback: signature mismatch!");
      return res.status(400).send("fail");
    }

    const { mchOrderNo, tradeResult, amount, merRetMsg } = body;

    if (tradeResult === "1") {
      const depositAmount = Number(amount);
      const targetUserId = (watchpayOrders[mchOrderNo] && watchpayOrders[mchOrderNo].userId) || merRetMsg;

      await db.collection("deposits").doc(mchOrderNo).set({
        orderNo: mchOrderNo,
        userId: targetUserId,
        amount: depositAmount,
        status: "success",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      if (targetUserId && targetUserId !== "guest" && targetUserId !== "deposit") {
        const userRef = db.collection("users").doc(targetUserId);
        await userRef.update({
          balance: admin.firestore.FieldValue.increment(depositAmount)
        });
        console.log(`Balance of ${depositAmount} BDT added to user: ${targetUserId}`);
      }

      return res.status(200).send("success");
    } else {
      await db.collection("deposits").doc(mchOrderNo).update({ status: "failed" });
      return res.status(200).send("success");
    }
  } catch (err) {
    console.error("Callback processing error:", err.message);
    return res.status(500).send("fail");
  }
});

app.get("/watchpay-order-status/:orderNo", (req, res) => {
  const order = watchpayOrders[req.params.orderNo];
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
