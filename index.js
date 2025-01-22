import bs58 from "bs58";
import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import axios from "axios";
import { TokenModel } from "./token.js";
import { TOKEN_PROGRAM_ID, getMint } from "@solana/spl-token";
import { Token, SPL_ACCOUNT_LAYOUT } from "@raydium-io/raydium-sdk";

import mongoose from "mongoose";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import {
  apiId,
  apiHash,
  rpc,
  pk,
  buy_amount,
  jitofee
} from "./config.js";

const dbURI = "mongodb://127.0.0.1:27017/signalbot";
const stringSession = new StringSession("");
const connection = new Connection(rpc);
const keypair = Keypair.fromSecretKey(bs58.decode(pk));

(async () => {
  try {
    await mongoose.connect(dbURI);
    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
  console.log("Loading interactive example...");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.start({
    phoneNumber: async () => await input.text("Please enter your number: "),
    password: async () => await input.text("Please enter your password: "),
    phoneCode: async () =>
      await input.text("Please enter the code you received: "),
    onError: (err) => console.log(err),
  });
  console.log("You should now be connected.");

  // const targetChannelId = "+neYb6dqvpXdmOTJl";
  client.addEventHandler(async (event) => {
    if (event.message) {
      const result = parseMessage(event.message);
      console.log("Message Parse Result = ", result);
      if (result == null) return;
      if (result.signal == "buy") {
        console.log(`==============> Buy Signal, Token = ${result.token}`);
        const startTime = performance.now();
        await buy(result.token);
        const endTime = performance.now();
        console.log(`==============> Buy End, Token = ${result.token}, ⏰time = ${endTime - startTime} milliseconds`)
      } else if (result.signal == "sell") {
        console.log(`==============> Sell Signal, Token = ${result.token}`);
        const startTime = performance.now();
        await sell(result.token);
        const endTime = performance.now();
        console.log(`==============> Sell End, Token = ${result.token}, ⏰time = ${endTime - startTime} milliseconds`);
      }
    }
  });
  sl_monitor();
})();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseMessage = (message) => {
  try {
    console.log("parseMessage, message = ", message.message);
    let token = getSubstringBetween(
      message.message,
      "📜CA: ",
      "\n🏛️Market Cap:"
    );
    if (token != null) {
      return { token, signal: "buy" };
    } else {
      if (message.message.includes("x from call,")) {
        token = message.media.webpage.url.substring(
          message.media.webpage.url.lastIndexOf("_") + 1
        );
        return { token, signal: "sell" };
      }
    }
  } catch (error) {
    return null;
  }
};

function getSubstringBetween(str, start, end) {
  const startIndex = str.indexOf(start);
  const endIndex = str.indexOf(end, startIndex + start.length);
  if (startIndex !== -1 && endIndex !== -1) {
    return str.substring(startIndex + start.length, endIndex);
  }
  return null;
}

const buy = async (token) => {
  const quoteResponse = await (
    await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${token}&amount=${buy_amount * LAMPORTS_PER_SOL}&slippageBps=5000`
    )
  ).json();
  const { swapTransaction } = await (
    await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
      }),
    })
  ).json();
  const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
  var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([keypair]);
  const txSignature = bs58.encode(transaction.signatures[0]);
  const latestBlockHash = await connection.getLatestBlockhash("processed");
  let result = await sendBundle(
    transaction,
    keypair,
    latestBlockHash,
    jitofee * LAMPORTS_PER_SOL
  );
  if (result) {
    const price = await getTokenPrice(token);
    console.log(`======>🟩 Buy Success, Token: ${token}, Price: ${price}, Tx: http://solscan.io/tx/${txSignature}`);
    const t = new TokenModel({ address: token, slPrice: price / 2, buyPrice: price });
    t.save();
  } else {
    console.log(`=======>🟥 Buy Failed, Token: ${token}`);
  }
};

const sell = async (token) => {
  const t = await TokenModel.findOne({ address: token });
  if (t == null) {
    console.log(`No have, Token: ${token}`);
    return;
  }

  // const tokenBalance = await getTokenBalance(keypair.publicKey, token, true);
  const tokenBalance = await getSPLBalance(connection, new PublicKey(token), keypair.publicKey);
  console.log(`Balance of Token: ${token} : ${tokenBalance}`);

  if (tokenBalance == 0) {
    console.log(`No Balance, Token: ${token}`);
    await TokenModel.findOneAndDelete({ address: token });
    return;
  }

  let sellAmount;
  if (t.sells == 0) {
    sellAmount = Math.floor(tokenBalance * 0.4);
    console.log('TP1 Hit, 40% Selling...');
  } else if (t.sells == 1) {
    sellAmount = Math.floor(tokenBalance * 0.5);
    console.log('TP2 Hit, 30% Selling...');
  } else if (t.sells == 2) {
    sellAmount = Math.floor(tokenBalance * 0.6);
    console.log('TP3 Hit, 20% Selling...');
  } else {
    sellAmount = tokenBalance;
    console.log('TP4 Hit, 10% Selling...');
  }

  const quoteResponse = await (
    await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${token}&outputMint=So11111111111111111111111111111111111111112&amount=${tokenBalance}&slippageBps=5000`
    )
  ).json();
  const { swapTransaction } = await (
    await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
      }),
    })
  ).json();
  const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
  var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([keypair]);
  const txSignature = bs58.encode(transaction.signatures[0]);
  const latestBlockHash = await connection.getLatestBlockhash("processed");
  let result = await sendBundle(transaction, keypair, latestBlockHash, jitofee * LAMPORTS_PER_SOL);
  if (result) {
    console.log(`🟩 Sell Success. Token: ${token}, Tx: http://solscan.io/tx/${txSignature}`);
    t.sells += 1;
    t.slPrice = t.buyPrice;
    t.save();
  } else {
    console.log(`🟥 Sell Failed. Token: ${token}`);
  }
};

const sl_monitor = async () => {
  while (true) {
    const tokens = await TokenModel.find({});
    for (let i = 0; i < tokens.length; i++) {
      // const tokenBalance = await getTokenBalance(
      //   keypair.publicKey,
      //   tokens[i].address,
      //   true
      // );
      const tokenBalance = await getSPLBalance(connection, new PublicKey(tokens[i].address), keypair.publicKey);

      if (tokenBalance == 0) continue;

      (async () => {
        const price = await getTokenPrice(tokens[i].address);
        if (price < tokens[i].slPrice) {
          const quoteResponse = await (
            await fetch(
              `https://quote-api.jup.ag/v6/quote?inputMint=${tokens[i].address}&outputMint=So11111111111111111111111111111111111111112&amount=${tokenBalance}&slippageBps=5000`
            )
          ).json();

          const { swapTransaction } = await (
            await fetch("https://quote-api.jup.ag/v6/swap", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                quoteResponse,
                userPublicKey: keypair.publicKey.toString(),
                wrapAndUnwrapSol: true,
              }),
            })
          ).json();

          const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
          var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
          transaction.sign([keypair]);
          const txSignature = bs58.encode(transaction.signatures[0]);
          const latestBlockHash = await connection.getLatestBlockhash(
            "processed"
          );
          let result = await sendBundle(
            transaction,
            keypair,
            latestBlockHash,
            jitofee
          );
          if (result) {
            console.log(`🟨 SL Sell. Token: ${tokens[i].address}, Buy Price:${tokens[i].buyPrice}, Sell Price: ${price}, TP Sells: ${tokens[i].sells} Tx: http://solscan.io/tx/${txSignature}`);
            TokenModel.findOneAndDelete({ address: tokens[i].address });
          }
        }
      })();
      await sleep(1000);
    }
  }
};

const getSPLBalance = async (
  connection,
  mintAddress,
  pubKey,
  allowOffCurve = false
) => {
  try {
    let ata = getAssociatedTokenAddressSync(mintAddress, pubKey, allowOffCurve);
    const balance = await connection.getTokenAccountBalance(ata, "processed");
    return Number(balance.value.amount);
  } catch (e) {
    console.log('getSPLBalance error ', e);
  }
  return 0;
};

export const getWalletTokenAccount = async (connection, wallet) => {
  const walletTokenAccount = await connection.getTokenAccountsByOwner(wallet, {
    programId: TOKEN_PROGRAM_ID,
  });
  return walletTokenAccount.value.map((i) => ({
    pubkey: i.pubkey,
    programId: i.account.owner,
    accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
  }));
};

const getTokenPrice = async (tokenAddress) => {
  try {
    const url = `https://api.jup.ag/price/v2?ids=${tokenAddress}`
    const resp = await axios.get(url);
    const priceData = resp.data;
    const priceKey = Object.keys(priceData.data)[0];
    const price = priceData.data[priceKey].price;
    return price;
  } catch (error) {
    console.log("getTokenPrice", error)
    return null;
  }
}

export const getTokenBalance = async (wallet, tokenAddress, lamports) => {
  const mint = new PublicKey(tokenAddress);
  const mintInfo = await getMint(connection, mint);
  const baseToken = new Token(
    TOKEN_PROGRAM_ID,
    tokenAddress,
    mintInfo.decimals
  );
  // console.log('token =', baseToken);
  const walletTokenAccounts = await getWalletTokenAccount(connection, wallet);
  let tokenBalance = 0;
  if (walletTokenAccounts && walletTokenAccounts.length > 0) {
    for (let walletTokenAccount of walletTokenAccounts) {
      if (walletTokenAccount.accountInfo.mint.toBase58() === tokenAddress) {
        if (lamports == true)
          tokenBalance = Number(walletTokenAccount.accountInfo.amount);
        else
          tokenBalance =
            Number(walletTokenAccount.accountInfo.amount) /
            10 ** baseToken.decimals;
        break;
      }
    }
  }
  return tokenBalance;
};

const jito_Validators = [
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
];

async function getRandomValidator() {
  const res =
    jito_Validators[Math.floor(Math.random() * jito_Validators.length)];
  return new PublicKey(res);
}

export async function sendBundle(
  transaction,
  payer,
  lastestBlockhash,
  jitofee
) {
  const jito_validator_wallet = await getRandomValidator();
  try {
    const jitoFee_message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: lastestBlockhash.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: jito_validator_wallet,
          lamports: jitofee,
        }),
      ],
    }).compileToV0Message();

    const jitoFee_transaction = new VersionedTransaction(jitoFee_message);
    jitoFee_transaction.sign([payer]);

    const serializedJitoFeeTransaction = bs58.encode(
      jitoFee_transaction.serialize()
    );
    const serializedTransaction = bs58.encode(transaction.serialize());

    const final_transaction = [
      serializedJitoFeeTransaction,
      serializedTransaction,
    ];

    console.log("Sending bundles...");

    const { data } = await axios.post(
      "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [final_transaction],
      }
    );

    let bundleIds = [];
    if (data) {
      console.log(data);
      bundleIds = [data.result];
    }

    console.log("Checking bundle's status...", bundleIds);
    const sentTime = Date.now();
    let confirmed = false;
    while (Date.now() - sentTime < 300000) {
      // 5 min
      try {
        const { data } = await axios.post(
          `https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles`,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "getBundleStatuses",
            params: [bundleIds],
          },
          {
            headers: {
              "Content-Type": "application/json",
            },
          }
        );

        if (data) {
          const bundleStatuses = data.result.value;
          console.log(`Bundle Statuses:`, bundleStatuses);
          let success = true;

          for (let i = 0; i < bundleIds.length; i++) {
            const matched = bundleStatuses.find(
              (item) => item && item.bundle_id === bundleIds[i]
            );
            if (!matched || matched.confirmation_status !== "confirmed") {
              // finalized
              success = false;
              break;
            }
          }

          if (success) {
            confirmed = true;
            break;
          }
        }
      } catch (err) {
        console.log("JITO ERROR:", err);
        break;
      }
      await sleep(1000);
    }
    return confirmed;
  } catch (e) {
    if (e instanceof axios.AxiosError) {
      console.log("Failed to execute the jito transaction");
    } else {
      console.log("Error during jito transaction execution: ", e);
    }
    return false;
  }
}
