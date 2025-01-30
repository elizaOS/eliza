export default [
    [
        {
            user: "{{user1}}",
            content: {
                text: "check the wallet balance of: {{address}}",
            },
        },
        {
            user: "{{agentName}}",
            content: {
                text: "Total Value of the portfolio is $5000",
                action: "getwallet_portfolio",
            },
        },
    ],
    [
        {
            user: "{{user1}}",
            content: {
                text: "what's the balance for {{address}}",
            },
        },
        {
            user: "{{agentName}}",
            content: {
                text: "I will fetch the portfolio for {{address}}",
                action: "getwallet_portfolio",
            },
        },
        {
            user: "{{agentName}}",
            content: {
                text: "Total Value of the portfolio is $40248.64",
            },
        },
    ],
];