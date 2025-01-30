export default [
    [
        {
            user: "{{user1}}",
            content: {
                text: "Show me the tokens in wallet 0x687fb7a442973c53674ac65bfcaf287860ba6db3",
            },
        },
        {
            user: "{{agentName}}",
            content: {
                text: "I'll fetch the token positions for wallet 0x687fb7a442973c53674ac65bfcaf287860ba6db3",
                action: "getwallet_positions",
            },
        },
    ],
    [
        {
            user: "{{user1}}",
            content: {
                text: "What tokens does 0x687fb7a442973c53674ac65bfcaf287860ba6db3 hold?",
            },
        },
        {
            user: "{{agentName}}",
            content: {
                text: "I'll check what tokens are held in wallet 0x687fb7a442973c53674ac65bfcaf287860ba6db3",
                action: "getwallet_positions",
            },
        },
        {
            user: "{{agentName}}",
            content: {
                text: "Total Portfolio Value: $40248.64\n\nToken Positions:\n",
            },
        },
    ],
    [
        {
            user: "{{user1}}",
            content: {
                text: "List the positions for 0x687fb7a442973c53674ac65bfcaf287860ba6db3",
            },
        },
        {
            user: "{{agentName}}",
            content: {
                text: "I'll get all token positions for wallet 0x687fb7a442973c53674ac65bfcaf287860ba6db3",
                action: "getwallet_positions",
            },
        },
    ],
]; 