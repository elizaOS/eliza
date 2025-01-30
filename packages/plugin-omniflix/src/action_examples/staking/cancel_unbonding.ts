export default [
    [
        {
            user: "{{user1}}",
            content: { text: "Cancel unbonding delegation of 100 FLIX to omniflixvaloper1abc123..., please let me know when it's done." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll cancel unbonding delegation of 100 FLIX to that validator right away.", 
                action: "CANCEL_UNBONDING" 
            }
        }
    ],
    [
        {
            user: "{{user1}}", 
            content: { text: "I want to cancel unbonding delegation of 50 FLIX to validator omniflixvaloper1abc123def456..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll help you cancel unbonding delegation of 50 FLIX to that validator.",
                action: "CANCEL_UNBONDING"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Can you cancel unbonding delegation of 75 FLIX to omniflixvaloper1xyz789..." } 
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll proceed to cancel unbonding delegation of 75 FLIX to that address.", 
                action: "CANCEL_UNBONDING" 
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Cancel unbonding" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll help you cancel an unbonding delegation. Please provide:\n1. The amount of FLIX to cancel unbonding\n2. The validator address",
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
                text: "Please provide the validator address.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "omniflixvaloper1abc123..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll proceed to cancel unbonding delegation of 100 FLIX to that address.", 
                action: "CANCEL_UNBONDING" 
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Cancel unbonding of -50 FLIX to omniflixvaloper1abc123..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "Invalid amount. The amount of FLIX to cancel unbonding must be a positive number.",
                action: "NONE"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Cancel unbonding of 100 FLIX to invalid_validator" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "The validator address 'invalid_validator' is not a valid Omniflix validator address. Please provide a valid validator address starting with 'omniflixvaloper1'.",
                action: "NONE"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Cancel unbonding of 50 FLIX to omniflixvaloper1def456..." }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "I'll proceed to cancel unbonding delegation of 50 FLIX to that address.", 
                action: "CANCEL_UNBONDING" 
            }
        }
    ]
]