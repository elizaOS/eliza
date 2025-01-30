export default [
    [
        {
            user: "{{user1}}",
            content: { text: "Send 100 FLIX to omniflix1abc123..., please let me know when it's done." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll send 100 FLIX to that address immediately.",
                action: "SEND_TOKENS"
            }
        },
    ],
    [
        {
            user: "{{user1}}", 
            content: { text: "Send 50 FLIX to omniflix1abc123def456..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll send 50 FLIX to that address right away.",
                action: "SEND_TOKENS"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Send tokens" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Please provide the amount of tokens you want to send and the recipient address.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "100 FLIX" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Please provide the recipient address for the transfer.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "omniflix1xyz789..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll send 100 FLIX to omniflix1xyz789... right away.",
                action: "SEND_TOKENS"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Send to omniflix1def456..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Please specify how many tokens you would like to send.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "75 FLIX" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll process the transfer of 75 FLIX to omniflix1def456...",
                action: "SEND_TOKENS"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Send 1000 FLIX" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Please provide the recipient address for the transfer.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "omniflix1invalid" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "Please provide a valid Omniflix address for the transfer request. The address should start with 'omniflix' and contain the correct number of characters." }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Send 500 FLIX to omniflix1ghi789..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll check your balance and process the transfer.",
                action: "SEND_TOKENS"
            }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "Error transferring tokens: Insufficient funds in the sender account" }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Can you send some FLIX for me?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll help you send FLIX. Please specify how many tokens you want to send and the recipient address.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "I want to send 250 FLIX to omniflix1pqr456..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll process the transfer of 250 FLIX to omniflix1pqr456...",
                action: "SEND_TOKENS"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Can you send some tokens?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'm sorry, but I can't perform that action. Please provide a valid address and amount to send tokens.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "Omniflix1abc123..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "You have provided recipient address. Please provide the amount of tokens to send.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "100 FLIX" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll process the transfer of 100 FLIX to omniflix1abc123 using authz account.",
                action: "SEND_TOKENS"
            }
        }
    ]
]