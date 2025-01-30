import axios from 'axios';
import { ethers } from 'ethers'
import { erc20Abi } from 'viem';

export const checkUserBalance = async (wallet, tokenAddress: string, _decimals) => {
    try {
        if (!wallet.provider) {
            throw new Error("Wallet must be connected to a provider.");
        }
        const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, wallet.provider);
        const address = await wallet.getAddress();
        const balance = await tokenContract.balanceOf(address);
        return balance.toString();
    } catch (_error) {  // Changed from 'error' to '_error' to indicate it's intentionally unused
        throw new Error("Unable to fetch balance");
    }
};

export const checkNativeTokenBalance = async (wallet, _decimals) => {

    try {
        if (!wallet.provider) {
            throw new Error("Wallet must be connected to a provider.");
        }

        const address = await wallet.getAddress();
        const balance = await wallet.provider.getBalance(address);
        return balance.toString();
    } catch (_error) {  // Changed from 'error' to '_error' to indicate it's intentionally unused
        throw new Error("Unable to fetch native token balance");
    }
};

export const checkAndSetAllowance = async (wallet, tokenAddress, approvalAddress, amount) => {
    if (tokenAddress === ethers.ZeroAddress || tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
        console.log("Native token detected; no approval needed.");
        return;
    }

    console.log(`Checking allowance for token ${tokenAddress} and approval address ${approvalAddress}`);

    const erc20ReadOnly = new ethers.Contract(tokenAddress, erc20Abi, wallet.provider);
    const walletAddress = await wallet.getAddress();

    try {
        const allowance = await erc20ReadOnly.allowance(walletAddress, approvalAddress);
        console.log("Current allowance:", allowance.toString());

        if (allowance < amount) {
            const erc20WithSigner = new ethers.Contract(tokenAddress, erc20Abi, wallet);
            const approveTx = await erc20WithSigner.approve(approvalAddress, amount);

            console.log(`Approve transaction sent: ${approveTx.hash}`);
            await approveTx.wait();
            console.log(`Approved successfully: ${approveTx.hash}`);
        } else {
            console.log("Sufficient allowance already set.");
        }
    } catch (error) {
        console.error("Error during allowance check or approval:", error);
    }
};

export const getSwapTransaction = async (quoteData, senderAddress, receiverAddress) => {
    const txDataUrl = "https://api-beta.pathfinder.routerprotocol.com/api/v2/transaction";

    const requestData = {
        ...quoteData,
        senderAddress: senderAddress,
        receiverAddress: receiverAddress
    };

    const config = {
        method: 'post',
        maxBodyLength: Number.POSITIVE_INFINITY,
        url: txDataUrl,
        headers: {
            'content-type': 'application/json'
        },
        data: requestData
    };

    try {
        const res = await axios.request(config);
        return res.data;
    } catch (e) {
        console.error(`Fetching tx data from pathfinder: ${e}`);
    }
}

