export default [
    [
        {
            user: "{{user1}}",
            content: { text: "Vote on proposal 1 with vote vote on option yes" }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'll help you vote on proposal 1 with vote VOTE_OPTION_YES.",
                action: "NONE"
            }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'll help you vote on proposal 1 with vote VOTE_OPTION_YES.",
                action: "VOTE_ON_PROPOSAL"
            }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'm sorry, but it seems that the address doesn't have any FLIX tokens to vote.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "I have funded my account FLIX." }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'll help you vote on proposal 1 with vote VOTE_OPTION_YES.",
                action: "VOTE_ON_PROPOSAL"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Vote on proposal 2 with vote vote on option abstain" }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'll help you vote on proposal 2 with vote VOTE_OPTION_ABSTAIN.",
                action: "VOTE_ON_PROPOSAL"
            }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "It seems that proposal 2 is voting period completed. Please provide a valid proposal ID.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "1" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll help you vote on proposal 1 with vote VOTE_OPTION_ABSTAIN.",
                action: "VOTE_ON_PROPOSAL"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Can you vote on proposal 1 with vote vote on option no" } 
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'll help you vote on proposal 1 with vote VOTE_OPTION_NO.",
                action: "VOTE_ON_PROPOSAL"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Vote on proposal 1 with vote vote on option no with veto" }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'll help you vote on proposal 1 with vote VOTE_OPTION_NO_WITH_VETO.",
                action: "VOTE_ON_PROPOSAL"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Vote on proposal 999" }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'll help you vote on proposal 999.",
                action: "VOTE_ON_PROPOSAL"
            }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I apologize, but proposal 999 doesn't exist. Please verify the proposal ID and try again.",
                action: "NONE"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Vote on proposal 4 with invalid option" }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "Invalid vote option. Please choose one of the following options: yes, no, abstain, or no_with_veto.",
                action: "NONE"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Vote on proposal" }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'll help you vote. Please provide the following information:\n1. Proposal ID\n2. Vote option (yes, no, abstain, or no_with_veto)",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "123456 yes" }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'll vote on proposal 1 with vote VOTE_OPTION_YES.",
                action: "VOTE_ON_PROPOSAL"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Vote on proposal 7" }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "Please specify your vote option (yes, no, abstain, or no_with_veto) for proposal 7.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "yes" }
        },
        {
            user: "{{FlixAgent}}",
            content: {
                text: "I'll vote on proposal 7 with vote VOTE_OPTION_YES.",
                action: "VOTE_ON_PROPOSAL"
            }
        }
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Vote yes" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I need the proposal ID to process your vote. Please provide the proposal number you'd like to vote on." }
        },
        {
            user: "{{user1}}",
            content: { text: "123456" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll vote on proposal 1 with vote VOTE_OPTION_YES.",
                action: "VOTE_ON_PROPOSAL"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Vote maybe on proposal 3" }
        },
        {
            user: "{{FlixAgent}}",
            content: { 
                text: "'Maybe' is not a valid voting option. Please choose from: yes, no, abstain, or no_with_veto.",
                action: "NONE"
            }
        },
        {
            user: "{{user1}}",
            content: { text: "yes" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll vote on proposal 7 with vote VOTE_OPTION_YES.",
                action: "VOTE_ON_PROPOSAL"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Vote yes on proposal 2" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll vote on proposal 2 with vote VOTE_OPTION_YES.",
                action: "VOTE_ON_PROPOSAL"
            }
        },
    ],
    [
        {
            user: "{{user1}}",
            content: { text: "Vote yes on proposal 3" }
        },
        {
            user: "{{FlixAgent}}",
            content: { text: "I'll vote on proposal 3 with vote VOTE_OPTION_YES.",
                action: "VOTE_ON_PROPOSAL"
            }
        }, 
    ]
]