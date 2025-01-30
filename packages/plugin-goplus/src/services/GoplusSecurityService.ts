import { type IAgentRuntime, ModelClass, Service, ServiceType, elizaLogger, generateObjectDeprecated, generateText } from "@elizaos/core";
import { GoPlusManage, type GoPlusParamType, GoPlusType } from "../lib/GoPlusManage";
import { requestPrompt, responsePrompt } from "../templates";

// Add type for check result
type GoPlusCheckResult = Record<string, unknown>;

export interface IGoplusSecurityService extends Service {
    check(text: string): Promise<string>;
}

export class GoplusSecurityService extends Service implements IGoplusSecurityService {
    private apiKey: string;
    private runtime: IAgentRuntime;
    getInstance(): GoplusSecurityService {
        return this;
    }
    static get serviceType() {
        return ServiceType.GOPLUS_SECURITY;
    }

    initialize(runtime: IAgentRuntime): Promise<void> {
        this.runtime = runtime;
        this.apiKey = runtime.getSetting("GOPLUS_API_KEY");
        return;
    }


    /**
     * Connect to WebSocket and send a message
     */
    async check(text: string): Promise<string> {
        try {
            elizaLogger.log("check input text", text);
            const obj = await generateObjectDeprecated({
                runtime: this.runtime,
                context: requestPrompt(text),
                modelClass: ModelClass.SMALL, // gpt-4o-mini
            }) as GoPlusParamType;

            elizaLogger.log("check generateObjectDeprecated text", obj);

            const goPlusManage = new GoPlusManage(this.apiKey)
            let checkResult: GoPlusCheckResult;
            switch(obj.type) {
                case GoPlusType.EVMTOKEN_SECURITY_CHECK:
                    checkResult = await goPlusManage.tokenSecurity(obj.network, obj.token);
                    break;
                case GoPlusType.SOLTOKEN_SECURITY_CHECK:
                    checkResult = await goPlusManage.solanaTokenSecurityUsingGET(obj.token);
                    break;
                case GoPlusType.SUITOKEN_SECURITY_CHECK:
                    checkResult = await goPlusManage.suiTokenSecurityUsingGET(obj.token);
                    break;
                case GoPlusType.RUGPULL_SECURITY_CHECK:
                    checkResult = await goPlusManage.rugpullDetection(obj.network, obj.contract);
                    break;
                case GoPlusType.NFT_SECURITY_CHECK:
                    checkResult = await goPlusManage.nftSecurity(obj.network, obj.token);
                    break;
                case GoPlusType.ADRESS_SECURITY_CHECK:
                    checkResult = await goPlusManage.addressSecurity(obj.wallet);
                    break;
                case GoPlusType.APPROVAL_SECURITY_CHECK:
                    checkResult = await goPlusManage.approvalSecurity(obj.network, obj.contract);
                    break;
                case GoPlusType.ACCOUNT_ERC20_SECURITY_CHECK:
                    checkResult = await goPlusManage.erc20ApprovalSecurity(obj.network, obj.wallet);
                    break;
                case GoPlusType.ACCOUNT_ERC721_SECURITY_CHECK:
                    checkResult = await goPlusManage.erc721ApprovalSecurity(obj.network, obj.wallet);
                    break;
                case GoPlusType.ACCOUNT_ERC1155_SECURITY_CHECK:
                    checkResult = await goPlusManage.erc1155ApprovalSecurity(obj.network, obj.wallet);
                    break;
                case GoPlusType.SIGNATURE_SECURITY_CHECK:
                    checkResult = await goPlusManage.inputDecode(obj.network, obj.data);
                    break;
                case GoPlusType.URL_SECURITY_CHECK:
                    checkResult = await goPlusManage.dappSecurityAndPhishingSite(obj.url);
                    break;
                default:
                    throw new Error("type is invaild")
            }

            elizaLogger.log("checkResult text", checkResult);
            const checkResponse = await generateText({
                runtime: this.runtime,
                context: responsePrompt(JSON.stringify(checkResult), text),
                modelClass: ModelClass.SMALL,
            });
            elizaLogger.log("checkResponse text", checkResponse);
            return checkResponse
        } catch (e) {
            elizaLogger.error(e);
            return "error";
        }
    }
}

export default GoplusSecurityService;
