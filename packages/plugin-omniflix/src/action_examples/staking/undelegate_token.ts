export default [
    [
        {
            user: "{{user1}}",
            content: { text: "undelegate 100 FLIX from omniflixvaloper1abc123..., please let me know when it's done." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll undelegate 100 FLIX from that address right away.",
                action: "TOKENS_UNDELEGATE"
            }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'm sorry, but it seems that validator omniflixvaloper1xyz... is not a valid validator. Please provide a valid validator address.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "omniflixvaloper1abc123..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll help you undelegate 100 FLIX from omniflixvaloper1abc123...",
                action: "TOKENS_UNDELEGATE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "When will I receive my tokens?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Your tokens will be available after a 21-day unbonding period. This is a network rule to maintain stability. I'll notify you when they're ready to use.",
                action: "NONE"
            }
        }
    ],
    [
        {
            user: "{{user1}}", 
            content: { text: "I want to undelegate 50 FLIX from validator omniflixvaloper1abc123def456..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll help you undelegate 50 FLIX from that validator. Processing your request now.",
                action: "TOKENS_UNDELEGATE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "I want to undelegate another 30 FLIX from the same validator" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'm sorry, but it seems that the amount you want to undelegate is greater than your current delegation. Please provide a valid amount.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "10 FLIX" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll help you undelegate 10 FLIX from omniflixvaloper1abc123def456...",
                action: "TOKENS_UNDELEGATE"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "undelegate FLIX" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I need more information to process your undelegation request. Please provide:\n1. The amount of FLIX you want to undelegate\n2. The validator address (starting with 'omniflixvaloper')" }
        },
        {
            user: "{{user1}}",
            content: { text: "I want to undelegate 200 FLIX from omniflixvaloper1xyz..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Processing your undelegation of 200 FLIX now.",
                action: "TOKENS_UNDELEGATE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "Let me undelegate 100 more FLIX from omniflixvaloper1xyz..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Processing the undelegation of 100 FLIX now.",
                action: "TOKENS_UNDELEGATE"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "undelegate 100 FLIX from invalidaddress123" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "The validator address you provided (invalidaddress123) is invalid. A valid validator address should start with 'omniflixvaloper'. Please provide a correct validator address.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "How can I find the correct validator address?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "You can find validator addresses on the OmniFlix Network explorer or through the official OmniFlix staking interface. Would you like me to provide more information about finding validators?",
                action: "NONE"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "undelegate 1000000 FLIX from omniflixvaloper1ghi..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I cannot process this undelegation. The requested amount (1000000 FLIX) exceeds your delegated balance with this validator. Please check your delegated balance and try again with a smaller amount.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "What is my delegated balance with that validator?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Your delegated balance with validator omniflixvaloper1ghi... is 10000 FLIX. Would you like to undelegate a smaller amount?",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "Yes, let me undelegate 5000 FLIX instead" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Processing the undelegation of 5000 FLIX now.",
                action: "TOKENS_UNDELEGATE"
            }
        }
    ]
]