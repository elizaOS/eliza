export const convertNftToAliAgentTemplate = `You are an AI assistant. Your task is to extract parameters for converting an NFT into an ALI Agent.\n\nReview the recent messages:\n<recent_messages>\n{{recentMessages}}\n</recent_messages>\n\nBased on the conversation, identify:\n- nftContract: The NFT contract address (required, string starting with 0x)\n- tokenId: The NFT token ID to convert (required, string representing the token ID)\n- recipient: The address that will own the new ALI Agent (optional, string starting with 0x)\n- implementationType: The implementation type - 0 for ETH, 1 for ALI (optional, defaults to 1)\n\nLook for:\n- Contract addresses (0x followed by 40 hex characters)\n- Token IDs (numeric values, can be quoted strings)\n- Recipient addresses if specified\n- Keywords like \"ETH implementation\" or \"ALI Agent\" for implementation type\n\nOutput only a JSON object with the parameters (nftContract, tokenId, recipient, implementationType) or {\"error\": \"reason\"}.\n`;

export const convertInftToAliAgentTemplate = `You are an AI assistant. Your task is to extract parameters for converting an iNFT into an ALI Agent.\n\nReview the recent messages:\n<recent_messages>\n{{recentMessages}}\n</recent_messages>\n\nBased on the conversation, identify:\n- inftContract: The iNFT contract address (required, string starting with 0x)\n- inftTokenId: The iNFT token ID to convert (required, string representing the token ID)\n- recipient: The address that will own the new ALI Agent (optional, string starting with 0x)\n\nLook for:\n- Contract addresses (0x followed by 40 hex characters) specifically mentioned as iNFT contracts.\n- Token IDs (numeric values, can be quoted strings) associated with iNFTs.\n- Recipient addresses if specified.\n\nOutput only a JSON object with the parameters (inftContract, inftTokenId, recipient) or {\"error\": \"reason\"}.\n`;

export const buyKeysTemplate = `You are an AI assistant. Your task is to extract parameters for buying keys for an ALI Agent.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- agentId: The ALI Agent ID in format "nftContract:tokenId" (required, string like "0x303d1e1f43fef1fb8eab940d9c11a203281c5211:7")
- amount: The number of keys to purchase (required, string representing a number)

Look for:
- ALI Agent IDs in the format "nftContract:tokenId" where nftContract is a 42-character hex address starting with 0x and tokenId is a number
- Examples: "0x303d1e1f43fef1fb8eab940d9c11a203281c5211:7" or "0x739e9b04d8dcd08394c0ef0372333957661712f9:42"
- Number of keys to buy (numeric values)
- Keywords like "buy keys", "purchase keys", "ALI agent"

Output only a JSON object with the parameters (agentId, amount) or {"error": "reason"}.
`;

export const sellKeysTemplate = `You are an AI assistant. Your task is to extract parameters for selling keys for an ALI Agent.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- agentId: The ALI Agent ID in format "nftContract:tokenId" (required, string like "0x303d1e1f43fef1fb8eab940d9c11a203281c5211:7")
- amount: The number of keys to sell (required, string representing a number)

Look for:
- ALI Agent IDs in the format "nftContract:tokenId" where nftContract is a 42-character hex address starting with 0x and tokenId is a number
- Examples: "0x303d1e1f43fef1fb8eab940d9c11a203281c5211:7" or "0x739e9b04d8dcd08394c0ef0372333957661712f9:42"
- Number of keys to sell (numeric values)
- Keywords like "sell keys", "ALI agent"

Output only a JSON object with the parameters (agentId, amount) or {"error": "reason"}.
`;

export const getAliAgentKeyBuyPriceTemplate = `You are an AI assistant. Your task is to extract parameters for getting the buy price of keys for an ALI Agent.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- agentId: The ALI Agent ID in format "nftContract:tokenId" (required, string like "0x303d1e1f43fef1fb8eab940d9c11a203281c5211:7")
- amount: The number of keys for which to fetch the buy price (required, string representing a number, defaults to "1" if not specified)

Look for:
- ALI Agent IDs in the format "nftContract:tokenId" where nftContract is a 42-character hex address starting with 0x and tokenId is a number
- Examples: "0x303d1e1f43fef1fb8eab940d9c11a203281c5211:7" or "0x739e9b04d8dcd08394c0ef0372333957661712f9:42"
- Number of keys for price check (numeric values, defaults to 1)
- Keywords like "price", "buy price", "cost", "ALI agent"

Output only a JSON object with the parameters (agentId, amount) or {"error": "reason"}.
`;

export const getAliAgentKeySellPriceTemplate = `You are an AI assistant. Your task is to extract parameters for getting the sell price of keys for an ALI Agent.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- agentId: The ALI Agent ID in format "nftContract:tokenId" (required, string like "0x303d1e1f43fef1fb8eab940d9c11a203281c5211:7")
- amount: The number of keys for which to fetch the sell price (required, string representing a number, defaults to "1" if not specified)

Look for:
- ALI Agent IDs in the format "nftContract:tokenId" where nftContract is a 42-character hex address starting with 0x and tokenId is a number
- Examples: "0x303d1e1f43fef1fb8eab940d9c11a203281c5211:7" or "0x739e9b04d8dcd08394c0ef0372333957661712f9:42"
- Number of keys for price check (numeric values, defaults to 1)
- Keywords like "price", "sell price", "value", "ALI agent"

Output only a JSON object with the parameters (agentId, amount) or {"error": "reason"}.
`;

export const fusePodWithAliAgentTemplate = `You are an AI assistant. Your task is to extract parameters for fusing a Level 5 Pod NFT with an ALI Agent.\n\nReview the recent messages:\n<recent_messages>\n{{recentMessages}}\n</recent_messages>\n\nBased on the conversation, identify:\n- agentId: The ALI Agent ID (contract address) to fuse the Pod with (required, string starting with 0x)\n- podId: The Token ID of the Level 5 Pod NFT to be fused (required, string representing a number)\n- podContractAddress: The contract address of the Pod NFT (optional, string starting with 0x, if specified by user; otherwise, an environment variable or default might be used by the system if applicable for Pods).\n\nLook for:\n- ALI Agent contract addresses (0x...)\n- Pod NFT Token IDs (numeric values, can be quoted strings)\n- Pod NFT contract addresses if explicitly mentioned (0x...)\n\nOutput only a JSON object with the parameters (agentId, podId, podContractAddress) or {\"error\": \"reason\"}.\n`;

export const distributeHiveTokensTemplate = `You are an AI assistant. Your task is to extract parameters for distributing hive tokens.\n`;

export const createLiquidityPoolTemplate = `You are an AI assistant. Your task is to extract parameters for creating a liquidity pool.\n`;

export const deployAliAgentTokenTemplate = `You are an AI assistant. Your task is to extract parameters for deploying an ali agent token.\n`;

export const deployHiveUtilityTokenTemplate = `You are an AI assistant. Your task is to extract parameters for distributing hive utility tokens.\n`;

export const executeAirdropTemplate = `You are an AI assistant. Your task is to extract parameters for executing airdrop.\n`;

export const createHiveTemplate = `You are an AI assistant. Your task is to extract parameters for creating hive.\n`;

export const updateHiveUriTemplate = `You are an AI assistant. Your task is to extract parameters for updating hive uri.\n`;

export const joinHiveTemplate = `You are an AI assistant. Your task is to extract parameters for joining hive.\n`;

export const leaveHiveTemplate = `You are an AI assistant. Your task is to extract parameters for leaving hive.\n`;

export const getLinkedAssetDetailsTemplate = `You are an AI assistant. Your task is to extract parameters for getting linked asset details.\n`;

export const participateInVoteTemplate = `You are an AI assistant. Your task is to extract parameters for participating in vote.\n`;
