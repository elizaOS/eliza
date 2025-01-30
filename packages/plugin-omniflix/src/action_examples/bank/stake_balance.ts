export default [
    [
        {
            user: "{{user1}}",
            content: { text: "What is my staked balance of my wallet?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Sure thing, I'll check that for you.",
                action: "GET_STAKE_BALANCE"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Check delegated balance for my wallet" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll check delegated balance for that address right away.",
                action: "GET_STAKE_BALANCE"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Can you tell me how many FLIX I have delegated?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll look up your delegated balance now.",
                action: "GET_STAKE_BALANCE"
            }
        },
    ],
    [
        {
            user: "{{user1}}", 
            content: { text: "Show me the delegated balance of my wallet" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "Let me fetch that delegated balance information for you." }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "What's my total FLIX holdings including delegated amount?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll check both your regular and delegated balances.",
                action: "GET_STAKE_BALANCE"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "I want to check my delegated balance" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Let me check that for you.",
                action: "GET_STAKE_BALANCE"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "How much FLIX do I have delegated ?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Let me check that for you.",
                action: "GET_STAKE_BALANCE"
            }
        },
    ]
]