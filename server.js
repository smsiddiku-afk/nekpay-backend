// NEKpay Payment Gateway Integration - Backend Server
// -----------------------------------------------------
// This server does 2 jobs:
// 1. /create-order  -> Called by your frontend (Google AI Studio site) when
//                       the user clicks "Deposit". It signs the request and
//                       asks NEKpay for a payment link, then returns that
//                       link to the frontend so the user can pay.
// 2. /nekpay-callback -> Called by NEKpay's servers (NOT your frontend) once
//                       the payment is completed. This verifies the sign and
//                       updates the order as paid.
//
// IMPORTANT: Keep this file and the .env file on your SERVER only.
// Never put MCH_ID / MCH_KEY inside your frontend (React/Google AI Studio) code.

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const qs = require("querystring");

const app = express();
app.use(express.urlencoded({ extended: true })); // NEKpay sends form-urlencoded data
app.use(express.json());

// ---------------------------------------------------------
// 1. CONFIG — Test credentials from the NEKpay Bengal doc
// ---------------------------------------------------------
const CONFIG = {
  MCH_ID: "999808888",          // Test Merchant ID (replace with real one later)
  MCH_KEY: "64d1b8592c5d4c1e841586b7651af06e", // Test collection key
  PAY_TYPE: "2220",             // Channel code for Bengal
  PAY_URL: "https://api.nekpayment.com/pay/web",

  // These MUST be public URLs once deployed (not localhost)
  NOTIFY_URL: "https://nekpay-backend.onrender.com/nekpay-callback",
  PAGE_URL: "https://YOUR-FRONTEND-DOMAIN.com/payment-result", // where user is redirected after paying
};

// In-memory order store for demo purposes.
// Replace this with a real database (MongoDB/Postgres/Firebase etc.) in production.
const orders = {};

// ---------------------------------------------------------
// 2. Helper: Generate MD5 sign
// NEKpay's rule: sort params alphabetically by key, join as
// key1=val1&key2=val2..., append &key=MCH_KEY at the end, then MD5 it.
// (This matches the exact example string given in their docs.)
// ---------------------------------------------------------
function generateSign(params, secretKey) {
  const sortedKeys = Object.keys(params)
    .filter((k) => params[k] !== "" && params[k] !== undefined && params[k] !== null && k !== "sign" && k !== "sign_type")
    .sort();

  const baseString =
    sortedKeys.map((k) => `${k}=${params[k]}`).join("&") + `&key=${secretKey}`;

  return crypto.createHash("md5").update(baseString, "utf8").digest("hex");
}

// ---------------------------------------------------------
// 3. Create Order — called by your frontend
// ---------------------------------------------------------
app.post("/create-order", async (req, res) => {
  try {
    const { amount, payerName } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // Generate a unique order number (use your own scheme in production, e.g. DB auto-increment + prefix)
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

    // Save order locally as "pending" before calling NEKpay
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
// 4. Callback — called by NEKpay servers when payment completes
// ---------------------------------------------------------
app.post("/nekpay-callback", (req, res) => {
  try {
    const body = req.body;
    console.log("Received NEKpay callback:", body);

    // Rebuild the signature the SAME way NEKpay did, to verify authenticity
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
      // TODO: update your real database here, credit user balance, etc.
      console.log(`Order ${mchOrderNo} marked as PAID`);
    } else {
      orders[mchOrderNo].status = "failed";
    }

    // NEKpay requires exactly the plain text "success" response,
    // otherwise it will keep resending the callback (up to 8 times).
    return res.status(200).send("success");
  } catch (err) {
    console.error("callback error:", err.message);
    return res.status(500).send("fail");
  }
});

// ---------------------------------------------------------
// 5. (Optional) Check order status from frontend, e.g. while polling
// ---------------------------------------------------------
app.get("/order-status/:orderNo", (req, res) => {
  const order = orders[req.params.orderNo];
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
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
