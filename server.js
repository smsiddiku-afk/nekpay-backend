// NEKpay Payment Gateway Integration - Backend Server
// -----------------------------------------------------
// This server does 2 jobs:
// 1. /create-order  -> Called by your frontend
// 2. /nekpay-callback -> Called by NEKpay's servers
//
// IMPORTANT: Keep this file and the .env file on your SERVER only.

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const qs = require("querystring");
const cors = require("cors");

const app = express();

// Enable CORS for frontend requests
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.urlencoded({ extended: true })); // NEKpay sends form-urlencoded data

// Capture raw body for signature verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---------------------------------------------------------
// 1. CONFIG — Live credentials for NEKpay
// ---------------------------------------------------------
const CONFIG = {
  MCH_ID: "808258213",
  MCH_KEY: "d3e912a25c7e4e059832173b16b9e3c9",
  PAY_TYPE: "2220",             // Channel code
  PAY_URL: "https://api.nekpayment.com/pay/web",

  NOTIFY_URL: "https://nekpay-backend.onrender.com/nekpay-callback",
  PAGE_URL: "https://novavest-a711c.web.app/payment-result",
};

// In-memory order store
const orders = {};

// ---------------------------------------------------------
// 2. Helper: Generate MD5 sign
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
        lower !== "signtype" // NEKpay's callback sends "signType" (camelCase),
        // while the outgoing request uses "sign_type" (snake_case).
        // Both must be excluded from the signature string, or callback
        // verification will always fail with "Signature mismatch".
      );
    })
    .sort();

  const baseString =
    sortedKeys.map((k) => `${k}=${params[k]}`).join("&") + `&key=${secretKey}`;

  return crypto.createHash("md5").update(baseString, "utf8").digest("hex");
}

// ---------------------------------------------------------
// 3. Create Order — called by your frontend
// ---------------------------------------------------------
app.post(["/create-order", "/api/v1/nekpay/create-order"], async (req, res) => {
  try {
    const { amount, payerName } = req.body;

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
      mch_return_msg: "deposit",
      payer_name: payerName || "Customer",
      sign_type: "MD5",
    };

    params.sign = generateSign(params, CONFIG.MCH_KEY);

    orders[mchOrderNo] = {
      amount: params.trade_amount,
      status: "pending",
      createdAt: new Date(),
    };

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

// ---------------------------------------------------------
// 4. Callback — called by NEKpay servers
// ---------------------------------------------------------
app.post("/nekpay-callback", (req, res) => {
  try {
    const body = req.body;
    console.log("Received NEKpay callback:", body);

    const expectedSign = generateSign(body, CONFIG.MCH_KEY);

    if (expectedSign !== body.sign) {
      console.warn("Signature mismatch! Possible fake callback.");
      return res.status(400).send("fail");
    }

    const { mchOrderNo, tradeResult, amount } = body;

    if (!orders[mchOrderNo]) {
      console.warn("Unknown order:", mchOrderNo);
      return res.status(400).send("fail");
    }

    if (tradeResult === "1") {
      orders[mchOrderNo].status = "paid";
      orders[mchOrderNo].paidAmount = amount;
      console.log(`Order ${mchOrderNo} marked as PAID`);
    } else {
      orders[mchOrderNo].status = "failed";
    }

    return res.status(200).send("success");
  } catch (err) {
    console.error("callback error:", err.message);
    return res.status(500).send("fail");
  }
});

// ---------------------------------------------------------
// 5. Check order status
// ---------------------------------------------------------
app.get("/order-status/:orderNo", (req, res) => {
  const order = orders[req.params.orderNo];
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

// ===========================================================
// WINYPAY Gateway
// ===========================================================
const WINYPAY_CONFIG = {
  MERCHANT_CODE: "M1001",
  SECRET_KEY: "abc123",
  PAYOUT_KEY: "abc123",
  BASE_URL: "https://winypay.com",
  PAYIN_PATH: "/api/v1/test/payin.php",
  PAYOUT_PATH: "/api/v1/test/payout.php",
  CALLBACK_URL: "https://nekpay-backend.onrender.com/winypay-callback",
  WITHDRAW_CALLBACK_URL: "https://nekpay-backend.onrender.com/winypay-payout-callback",
  JUMP_URL: "https://novavest-a711c.web.app/payment-result",
};

const winypayOrders = {};
const winypayPayouts = {};

// -----------------------------------------------------------
// 6. Create PayIn (Deposit)
// -----------------------------------------------------------
app.post("/create-order-winypay", async (req, res) => {
  try {
    const { amount, userId, payType } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    const orderId = "DEP" + Date.now();

    const payload = {
      merchant_code: WINYPAY_CONFIG.MERCHANT_CODE,
      secret_key: WINYPAY_CONFIG.SECRET_KEY,
      order_id: orderId,
      user_id: userId || "GUEST",
      order_amount: Number(amount).toFixed(2),
      pay_type: payType || "bkash",
      current_time: formatDate(new Date()),
      jump_url: WINYPAY_CONFIG.JUMP_URL,
      callback_url: WINYPAY_CONFIG.CALLBACK_URL,
    };

    winypayOrders[orderId] = {
      amount: payload.order_amount,
      status: "pending",
      createdAt: new Date(),
    };

    const response = await axios.post(
      WINYPAY_CONFIG.BASE_URL + WINYPAY_CONFIG.PAYIN_PATH,
      payload,
      { headers: { "Content-Type": "application/json" } }
    );

    const data = response.data;

    if (data.status === "success" && data.pay_url) {
      return res.json({
        success: true,
        paymentLink: data.pay_url,
        orderNo: orderId,
      });
    } else {
      winypayOrders[orderId].status = "failed";
      return res.status(400).json({
        success: false,
        message: data.message || "Order creation failed",
      });
    }
  } catch (err) {
    console.error("create-order-winypay error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// -----------------------------------------------------------
// 7. PayIn Callback
// -----------------------------------------------------------
app.post("/winypay-callback", (req, res) => {
  try {
    const signatureHeader = req.headers["x-callback-sign"];
    const expectedSign = crypto
      .createHmac("sha256", WINYPAY_CONFIG.SECRET_KEY)
      .update(req.rawBody)
      .digest("hex");

    if (signatureHeader !== expectedSign) {
      console.warn("WinyPay PayIn callback: signature mismatch!");
      return res.status(400).json({ status: "error" });
    }

    const { order_id, status: txnStatus } = req.body;
    console.log("WinyPay PayIn callback:", req.body);

    if (!winypayOrders[order_id]) {
      console.warn("Unknown WinyPay order:", order_id);
    } else if (txnStatus === "success") {
      winypayOrders[order_id].status = "paid";
    } else {
      winypayOrders[order_id].status = "failed";
    }

    return res.status(200).json({ status: "success" });
  } catch (err) {
    console.error("winypay-callback error:", err.message);
    return res.status(500).json({ status: "error" });
  }
});

// -----------------------------------------------------------
// 8. Create PayOut (Withdrawal)
// -----------------------------------------------------------
app.post("/create-payout-winypay", async (req, res) => {
  try {
    const { amount, userId, accountNo, accountName, payType } = req.body;

    if (!amount || Number(amount) <= 0 || !accountNo) {
      return res.status(400).json({ success: false, message: "Invalid amount or account number" });
    }

    const orderId = "WDR" + Date.now();

    const payload = {
      merchant_code: WINYPAY_CONFIG.MERCHANT_CODE,
      payout_key: WINYPAY_CONFIG.PAYOUT_KEY,
      order_id: orderId,
      user_id: userId || "GUEST",
      amount: Number(amount).toFixed(2),
      pay_type: payType || "bkash",
      account_no: accountNo,
      account_name: accountName || "",
      current_time: formatDate(new Date()),
      callback_url: WINYPAY_CONFIG.WITHDRAW_CALLBACK_URL,
    };

    winypayPayouts[orderId] = {
      amount: payload.amount,
      accountNo,
      status: "pending",
      createdAt: new Date(),
    };

    const response = await axios.post(
      WINYPAY_CONFIG.BASE_URL + WINYPAY_CONFIG.PAYOUT_PATH,
      payload,
      { headers: { "Content-Type": "application/json" } }
    );

    const data = response.data;

    if (data.status === "success") {
      return res.json({
        success: true,
        message: data.message,
        orderNo: orderId,
      });
    } else {
      winypayPayouts[orderId].status = "failed";
      return res.status(400).json({
        success: false,
        message: data.message || "Payout request failed",
      });
    }
  } catch (err) {
    console.error("create-payout-winypay error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// -----------------------------------------------------------
// 9. PayOut Callback
// -----------------------------------------------------------
app.post("/winypay-payout-callback", (req, res) => {
  try {
    const signatureHeader = req.headers["x-callback-sign"];
    const expectedSign = crypto
      .createHmac("sha256", WINYPAY_CONFIG.PAYOUT_KEY)
      .update(req.rawBody)
      .digest("hex");

    if (signatureHeader !== expectedSign) {
      console.warn("WinyPay PayOut callback: signature mismatch!");
      return res.status(400).json({ status: "error" });
    }

    const { order_id, status: txnStatus } = req.body;
    console.log("WinyPay PayOut callback:", req.body);

    if (!winypayPayouts[order_id]) {
      console.warn("Unknown WinyPay payout order:", order_id);
    } else if (txnStatus === "success") {
      winypayPayouts[order_id].status = "completed";
    } else {
      winypayPayouts[order_id].status = "failed";
    }

    return res.status(200).json({ status: "success" });
  } catch (err) {
    console.error("winypay-payout-callback error:", err.message);
    return res.status(500).json({ status: "error" });
  }
});

// -----------------------------------------------------------
// 10. Status checks
// -----------------------------------------------------------
app.get("/winypay-order-status/:orderNo", (req, res) => {
  const order = winypayOrders[req.params.orderNo];
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

app.get("/winypay-payout-status/:orderNo", (req, res) => {
  const payout = winypayPayouts[req.params.orderNo];
  if (!payout) return res.status(404).json({ error: "Payout not found" });
  res.json(payout);
});

// ---------------------------------------------------------
function formatDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NEKpay backend running on port ${PORT}`));