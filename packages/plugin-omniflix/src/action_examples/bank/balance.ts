export default [
    [
        {
            user: "{{user1}}",
            content: { text: "What is my balance of my wallet?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Sure thing, I'll check that for you.",
                action: "GET_BALANCE"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Can you tell me how many FLIX I have in my wallet?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll look up your wallet balance now.",
                action: "GET_BALANCE"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "What's my total FLIX holdings including staked amount?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll check both your regular and staked balances.",
                action: "GET_BALANCE"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "I want to check my balance" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Let me check that for you.",
                action: "GET_BALANCE"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "How much FLIX do I have?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Let me check that for you.",
                action: "GET_BALANCE"
            }
        },
    ]
]