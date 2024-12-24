
export const mintNFTTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "collectionAddress": "D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS",
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested mint nft:
- collection contract address

Respond with a JSON markdown block containing only the extracted values.

Note: Make sure to extract the collection address from the most recent messages whenever possible.`;
