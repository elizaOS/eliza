import { Address, beginCell, Dictionary, fromNano, MessageRelaxed, Slice, toNano, TonClient, TupleReader } from "@ton/ton";
import { StakingPlatform } from "../interfaces/stakingPlatform.ts";
import { internal } from "@ton/ton";
import { WalletProvider } from "../../../providers/wallet.ts";

interface MemberData {
    address: Address;      
    profit_per_coin: string;
    balance: string;
    pending_withdraw: string;
    pending_withdraw_all: boolean;
    pending_deposit: string;
    member_withdraw: string;
}

type MemberList = MemberData[];


function generateQueryId() {
    // Generate a query ID that's unique for this transaction
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

function parseMembersRaw(stack: any): MemberList {
    const cell = stack.items[0].cell;
    
    const dict = Dictionary.loadDirect(
        Dictionary.Keys.BigInt(256),
        {
            serialize: (src: any, builder: any) => {},
            parse: (slice: Slice) => {
                try {
                    const profitPerCoin = slice.loadUintBig(128);
                    const balance = slice.loadCoins();
                    const pendingWithdraw = slice.loadCoins();
                    const pendingWithdrawAll = slice.loadUintBig(1) === 1n;
                    const pendingDeposit = slice.loadCoins();
                    const memberWithdraw = slice.loadCoins();
                    
                    return {
                        profit_per_coin: profitPerCoin.toString(),
                        balance: balance.toString(),
                        pending_withdraw: pendingWithdraw.toString(),
                        pending_withdraw_all: pendingWithdrawAll,
                        pending_deposit: pendingDeposit.toString(),
                        member_withdraw: memberWithdraw.toString()
                    };
                } catch (e) {
                    console.error("Parse error:", e);
                    return {
                        error: e.message,
                        sliceData: slice.toString()
                    };
                }
            }
        },
        cell
    );

    const members: MemberList = [];
    
    for (const [key, value] of dict) {
        // Convert key to proper hex format
        let bigIntKey: bigint;
        if (typeof key === 'bigint') {
            bigIntKey = key;
        } else if (typeof key === 'string') {
            const numStr = (key as string).startsWith('b:') ? (key as string).substring(2) : key;
            bigIntKey = BigInt(numStr);
        } else {
            bigIntKey = BigInt((key as any).toString());
        }
        
        if (bigIntKey < 0n) {
            bigIntKey = (1n << 256n) + bigIntKey;
        }
        
        const rawAddress = bigIntKey.toString(16).replace('0x', '').padStart(64, '0');
        const address = new Address(0, Buffer.from(rawAddress, 'hex')).toString({bounceable:false, testOnly: true});

        members.push({
            address,
            ...value
        });
    }

    return members;
}

export class TonWhalesStrategy implements StakingPlatform {
    constructor(readonly tonClient: TonClient, readonly walletProvider: WalletProvider) {}

    async getPendingWithdrawal(walletAddress: string, poolAddress: string): Promise<Number> {
        const memberData = await this.getMemberData(walletAddress, poolAddress);

        return parseInt(fromNano(memberData.pending_withdraw));
    }

    async getStakedTon(walletAddress: string, poolAddress: string): Promise<Number> {
        const memberData = await this.getMemberData(walletAddress, poolAddress);

        return parseInt(fromNano(memberData.balance));
    }

    async getPoolInfo(poolAddress: string): Promise<any> {
        try {
            const result = await this.tonClient.runMethod(
                Address.parse(poolAddress), 
                "get_pool_status"
            );
            
            // Parse the stack result based on TonWhales contract structure
            const status = result.stack;
            return {
                totalStaked: status.readBigNumber(),
                hasWithdraw: status.readBoolean(),
                withdrawRequests: status.readNumber(),
                nextRoundSince: status.readNumber(),
                stakeHeld: status.readNumber(),
                minStake: BigInt(10_000_000_000), // 10 TON in nanotons
                apy: 5.2 // Fixed APY for TonWhales
            };
        } catch (error) {
            console.error("Error fetching TonWhales pool info:", error);
            throw error;
        }
    }

        async createStakeMessage(poolAddress: string, amount: number): Promise<MessageRelaxed> {
            const queryId = generateQueryId();
    
            const payload = beginCell()
                .storeUint(2077040623, 32) 
                .storeUint(queryId, 64)    
                .storeCoins(100000)  // gas
                .endCell();
    
            const intMessage = internal({
                to: poolAddress,
                value: toNano(amount),
                bounce: true,
                init: null,
                body: payload,
            });
    
            return intMessage;
        }
    
        async createUnstakeMessage(poolAddress: string, amount: number): Promise<MessageRelaxed> {
            const queryId = generateQueryId();
    
            const payload = beginCell()
                .storeUint(3665837821, 32) 
                .storeUint(queryId, 64)    
                .storeCoins(100000) // gas
                .storeCoins(amount)
                .endCell();
            
            const intMessage = internal({
                to: poolAddress,
                value: 200000000n,//toNano(unstakeAmount),
                bounce: true,
                init: null,
                body: payload, // Adjust this message if your staking contract requires a different format.
            });
    
            return intMessage;
        }

        private async getMemberData(address: string, poolAddress: string) : Promise<MemberData> {
            const result = await this.tonClient.runMethod(
                Address.parse(poolAddress), 
                "get_members_raw"
            );
        
            const memberData = await parseMembersRaw(result.stack);
        
            console.info(memberData)

            return memberData.find(e=>e.address.equals(Address.parse(address)));
        }
        
}