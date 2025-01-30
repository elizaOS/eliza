export default [
    [
        {
            user: "{{user1}}",
            content: { text: "Delegate 100 FLIX to omniflixvaloper1abc123..., please let me know when it's done." }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll delegate 100 FLIX to that address right away.",
                action: "DELEGATE_TOKEN"
            }
        }
    ],
    [
        {
            user: "{{user1}}", 
            content: { text: "I want to delegate 50 FLIX to validator omniflixvaloper1abc123def456..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll process your delegation request of 50 FLIX now.",
                action: "DELEGATE_TOKEN"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Can you delegate 75 FLIX to omniflixvaloper1xyz789..." } 
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll process your delegation request of 75 FLIX now.",
                action: "DELEGATE_TOKEN"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "delegate FLIX" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I need more information to process your delegation request. Please provide:\n1. The amount of FLIX you want to delegate\n2. The validator address (starting with 'omniflixvaloper')",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "I want to delegate 200 FLIX to omniflixvaloper1def..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll process your delegation request of 200 FLIX now.",
                action: "DELEGATE_TOKEN"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "delegate 1000000 FLIX to omniflixvaloper1ghi..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "Processing your delegation of 1000000 FLIX now.",
                action: "DELEGATE_TOKEN"
            }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'm sorry, but it seems like you don't have enough FLIX to delegate. Please check your balance and try again.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "Okay, can you delegate 100 FLIX instead?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll process your delegation request of 100 FLIX now.",
                action: "DELEGATE_TOKEN"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "delegate 100 FLIX to invalidaddress123" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "The validator address you provided is invalid. A valid validator address should start with 'omniflixvaloper'. Please provide a correct validator address.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "How do I find validator addresses?" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "You can find validator addresses on the OmniFlix Network explorer or through the official OmniFlix staking interface. Would you like me to provide more information about finding validators?",
                action: "NONE"
            }
        }
    ]
]