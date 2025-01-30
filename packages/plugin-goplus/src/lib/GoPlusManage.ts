export const GoPlusType = {
    EVMTOKEN_SECURITY_CHECK: "EVMTOKEN_SECURITY_CHECK",
    SOLTOKEN_SECURITY_CHECK: "SOLTOKEN_SECURITY_CHECK",
    SUITOKEN_SECURITY_CHECK: "SUITOKEN_SECURITY_CHECK",
    RUGPULL_SECURITY_CHECK: "RUGPULL_SECURITY_CHECK",
    NFT_SECURITY_CHECK: "NFT_SECURITY_CHECK",
    ADRESS_SECURITY_CHECK: "ADRESS_SECURITY_CHECK",
    APPROVAL_SECURITY_CHECK: "APPROVAL_SECURITY_CHECK",
    ACCOUNT_ERC20_SECURITY_CHECK: "ACCOUNT_ERC20_SECURITY_CHECK",
    ACCOUNT_ERC721_SECURITY_CHECK: "ACCOUNT_ERC721_SECURITY_CHECK",
    ACCOUNT_ERC1155_SECURITY_CHECK: "ACCOUNT_ERC1155_SECURITY_CHECK",
    SIGNATURE_SECURITY_CHECK: "SIGNATURE_SECURITY_CHECK",
    URL_SECURITY_CHECK: "URL_SECURITY_CHECK",
} as const;

export type GoPlusTypeType = (typeof GoPlusType)[keyof typeof GoPlusType];

export type GoPlusParamType = {
    "type": (typeof GoPlusType)[keyof typeof GoPlusType],
    "network"?: string,
    "token"?: string,
    "contract"?: string,
    "wallet"?: string,
    "url"?: string,
    "data"?: string,
}

export class GoPlusManage {
    private apiKey: string;

    constructor(apiKey: string = null) {
        this.apiKey = apiKey;
    }

    async requestGet(api: string) {
        const myHeaders = new Headers();
        if (this.apiKey) {
            myHeaders.append("Authorization", this.apiKey);
        }
        const url = `https://api.gopluslabs.io/${api}`
        const res = await fetch(url, {
            method: "GET",
            headers: myHeaders,
            redirect: "follow"
            })

        return await res.json();
    }

    async tokenSecurity(chainId: string, address: string) {
        const api = `api/v1/token_security/${chainId}?contract_addresses=${address}`;
        return await this.requestGet(api)
    }

    async rugpullDetection(chainId: string, address: string) {
        const api = `api/v1/rugpull_detecting/${chainId}?contract_addresses=${address}`;
        return await this.requestGet(api)
    }

    async solanaTokenSecurityUsingGET(address: string) {
        const api = `api/v1/solana/token_security?contract_addresses=${address}`;
        return await this.requestGet(api)
    }

    async suiTokenSecurityUsingGET(address: string) {
        const api = `api/v1/sui/token_security?contract_addresses=${address}`;
        return await this.requestGet(api)
    }

    async nftSecurity(chainId: string, address: string) {
        const api = `api/v1/nft_security/${chainId}?contract_addresses=${address}`;
        return await this.requestGet(api)
    }

    async addressSecurity(address: string) {
        const api = `api/v1/address_security/${address}`;
        return await this.requestGet(api)
    }

    async approvalSecurity(chainId: string, contract: string) {
        const api = `api/v1/approval_security/${chainId}?contract_addresses=${contract}`;
        return await this.requestGet(api)
    }

    async erc20ApprovalSecurity(chainId: string, wallet: string) {
        const api = `api/v2/token_approval_security/${chainId}?addresses=${wallet}`;
        return await this.requestGet(api)
    }

    async erc721ApprovalSecurity(chainId: string, wallet: string) {
        const api = `api/v2/nft721_approval_security/${chainId}?addresses=${wallet}`;
        return await this.requestGet(api)
    }

    async erc1155ApprovalSecurity(chainId: string, wallet: string) {
        const api = `api/v2/nft1155_approval_security/${chainId}?addresses=${wallet}`;
        return await this.requestGet(api)
    }

    async inputDecode(chainId: string, data: string) {
        const body = JSON.stringify({
            chain_id: chainId,
            data: data,
        })
        const res = await fetch("https://api.gopluslabs.io/api/v1/abi/input_decode", {
            "headers": {
              "accept": "*/*",
              "accept-language": "en,zh-CN;q=0.9,zh;q=0.8",
              "content-type": "application/json"
            },
            "body": body,
            "method": "POST"
          });
        return await res.json();
    }

    async dappSecurityAndPhishingSite(url: string) {
        const api = `api/v1/dapp_security?url=${url}`;
        const data1 = await this.requestGet(api)

        const api2 = `api/v1/phishing_site?url=${url}`;
        const data2 = await this.requestGet(api2)
        return {
            data1,
            data2
        }
    }
}
