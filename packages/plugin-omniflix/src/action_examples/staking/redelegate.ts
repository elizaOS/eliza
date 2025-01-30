export default [
    [
        {
            user: "{{user1}}",
            content: { text: "Redelegate 100 FLIX from omniflixvaloper1abc123... to omniflixvaloper1def456..., please let me know when it's done." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll redelegate 100 FLIX from that address right away.",
                action: "TOKENS_REDELEGATE"
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
            content: { text: "I'll help you redelegate 100 FLIX from omniflixvaloper1abc123... to omniflixvaloper1def456...",
                action: "TOKENS_REDELEGATE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "How long until I can redelegate these tokens again?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "There is a 21-day waiting period before you can redelegate these tokens again. This is a network rule to maintain stability.",
                action: "NONE"
            }
        }
    ],
    [
        {
            user: "{{user1}}", 
            content: { text: "I want to redelegate 50 FLIX from validator omniflixvaloper1abc123... to validator omniflixvaloper1def456..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll help you redelegate 50 FLIX from that validator. Processing your request now.",
                action: "TOKENS_REDELEGATE"
            }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'm sorry, but the amount of FLIX you provided is invalid. Please provide a valid amount of FLIX.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "50 FLIX" }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'll help you redelegate 50 FLIX from omniflixvaloper1abc123... to omniflixvaloper1def456...",
                action: "TOKENS_REDELEGATE"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Can you redelegate 75 FLIX from omniflixvaloper1abc123... to omniflixvaloper1xyz789..." } 
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll process your redelegation request of 75 FLIX now.",
                action: "TOKENS_REDELEGATE"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "redelegate FLIX" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I need more information to process your redelegation request. Please provide:\n1. The amount of FLIX you want to redelegate\n2. The source validator address (starting with 'omniflixvaloper')\n3. The destination validator address (starting with 'omniflixvaloper')",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "I want to redelegate 200 FLIX from omniflixvaloper1xyz... to omniflixvaloper1pqr..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Processing your redelegation of 200 FLIX now.",
                action: "TOKENS_REDELEGATE"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "redelegate 100 FLIX from invalidaddress123 to omniflixvaloper1def..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "The source validator address you provided (invalidaddress123) is invalid. A valid validator address should start with 'omniflixvaloper'. Please provide a correct validator address.",
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
            content: { text: "redelegate 1000000 FLIX from omniflixvaloper1abc... to omniflixvaloper1def..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I cannot process this redelegation. The requested amount (1000000 FLIX) exceeds your delegated balance with the source validator. Please check your delegated balance and try again with a smaller amount.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "What is my delegated balance?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Sure, Let me check your delegated balance.",
                action: "GET_BALANCE"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "redelegate 50 FLIX from omniflixvaloper1abc... to omniflixvaloper1def..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll help you redelegate 50 FLIX from omniflixvaloper1abc... to omniflixvaloper1def...",
                action: "TOKENS_REDELEGATE"
            }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I apologize, but it seems these tokens were redelegated recently. You need to wait for the 21-day cooling period to complete before redelegating these tokens again.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "Can I delegate to a different validator instead?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Yes, you can make a new delegation to any validator using your available (non-staked) FLIX tokens. Would you like to do that instead?",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "Yes, I want to delegate to a different validator." }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "Great! I'll help you delegate to a different validator. Please provide the new validator address and the amount of FLIX you want to delegate.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "omniflixvaloper1abc123..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll help you delegate 50 FLIX to omniflixvaloper1abc123...",
                action: "TOKENS_REDELEGATE"
            }
        }
    ]
]