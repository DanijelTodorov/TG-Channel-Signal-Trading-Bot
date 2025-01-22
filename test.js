import axios from "axios";
import { PublicKey, Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getMint, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { rpc } from "./config.js";
import { Token, SPL_ACCOUNT_LAYOUT } from "@raydium-io/raydium-sdk";

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

const connection = new Connection(rpc);

const getTokenBalance = async (wallet, tokenAddress, lamports) => {
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
        console.log('error ', e);
    }
    return null;
};

const startTime = performance.now();
// const balance = await getTokenBalance(new PublicKey("DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm"), "9sbrLLnk4vxJajnZWXP9h5qk1NDFw7dz2eHjgemcpump", true);
const balance = await getSPLBalance(connection, new PublicKey("9sbrLLnk4vxJajnZWXP9h5qk1NDFw7dz2eHjgemcpump"), new PublicKey("DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm"));
console.log('balance = ', balance);
const endTime = performance.now();
console.log(`Execution time: ${endTime - startTime} milliseconds`);