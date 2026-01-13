#![allow(missing_docs)]

use crate::types::{ElizaPattern, ElizaRule};
use regex::Regex;

pub fn get_default_patterns() -> Vec<ElizaPattern> {
    vec![
        ElizaPattern {
            keyword: "sorry".to_string(),
            weight: 1,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "Please don't apologize.".to_string(),
                    "Apologies are not necessary.".to_string(),
                    "What feelings do you have when you apologize?".to_string(),
                    "I've told you that apologies are not required.".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "remember".to_string(),
            weight: 5,
            rules: vec![
                ElizaRule {
                    pattern: Regex::new(r"(?i)do you remember (.*)").unwrap(),
                    responses: vec![
                        "Did you think I would forget $1?".to_string(),
                        "Why do you think I should recall $1 now?".to_string(),
                        "What about $1?".to_string(),
                        "You mentioned $1.".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)i remember (.*)").unwrap(),
                    responses: vec![
                        "Do you often think of $1?".to_string(),
                        "Does thinking of $1 bring anything else to mind?".to_string(),
                        "What else do you remember?".to_string(),
                        "Why do you remember $1 just now?".to_string(),
                    ],
                },
            ],
        },
        ElizaPattern {
            keyword: "if".to_string(),
            weight: 3,
            rules: vec![ElizaRule {
                pattern: Regex::new(r"(?i)if (.*)").unwrap(),
                responses: vec![
                    "Do you think it's likely that $1?".to_string(),
                    "Do you wish that $1?".to_string(),
                    "What do you know about $1?".to_string(),
                    "Really, if $1?".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "dreamed".to_string(),
            weight: 4,
            rules: vec![ElizaRule {
                pattern: Regex::new(r"(?i)i dreamed (.*)").unwrap(),
                responses: vec![
                    "Really, $1?".to_string(),
                    "Have you ever fantasized $1 while you were awake?".to_string(),
                    "Have you ever dreamed $1 before?".to_string(),
                    "What does that dream suggest to you?".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "dream".to_string(),
            weight: 3,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "What does that dream suggest to you?".to_string(),
                    "Do you dream often?".to_string(),
                    "What persons appear in your dreams?".to_string(),
                    "Do you believe that dreams have something to do with your problems?"
                        .to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "perhaps".to_string(),
            weight: 0,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "You don't seem quite certain.".to_string(),
                    "Why the uncertain tone?".to_string(),
                    "Can't you be more positive?".to_string(),
                    "You aren't sure?".to_string(),
                    "Don't you know?".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "name".to_string(),
            weight: 15,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "I am not interested in names.".to_string(),
                    "I've told you before, I don't care about names -- please continue."
                        .to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "hello".to_string(),
            weight: 0,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "How do you do. Please state your problem.".to_string(),
                    "Hi. What seems to be your problem?".to_string(),
                    "Hello. Tell me what's on your mind.".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "hi".to_string(),
            weight: 0,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "How do you do. Please state your problem.".to_string(),
                    "Hi there. What brings you here today?".to_string(),
                    "Hello. Tell me what's on your mind.".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "computer".to_string(),
            weight: 50,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "Do computers worry you?".to_string(),
                    "Why do you mention computers?".to_string(),
                    "What do you think machines have to do with your problem?".to_string(),
                    "Don't you think computers can help people?".to_string(),
                    "What about machines worries you?".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "am".to_string(),
            weight: 0,
            rules: vec![
                ElizaRule {
                    pattern: Regex::new(r"(?i)am i (.*)").unwrap(),
                    responses: vec![
                        "Do you believe you are $1?".to_string(),
                        "Would you want to be $1?".to_string(),
                        "Do you wish I would tell you you are $1?".to_string(),
                        "What would it mean if you were $1?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)i am (.*)").unwrap(),
                    responses: vec![
                        "Is it because you are $1 that you came to me?".to_string(),
                        "How long have you been $1?".to_string(),
                        "How do you feel about being $1?".to_string(),
                        "Do you enjoy being $1?".to_string(),
                        "Do you believe it is normal to be $1?".to_string(),
                    ],
                },
            ],
        },
        ElizaPattern {
            keyword: "are".to_string(),
            weight: 0,
            rules: vec![
                ElizaRule {
                    pattern: Regex::new(r"(?i)are you (.*)").unwrap(),
                    responses: vec![
                        "Why are you interested in whether I am $1 or not?".to_string(),
                        "Would you prefer if I weren't $1?".to_string(),
                        "Perhaps I am $1 in your fantasies.".to_string(),
                        "Do you sometimes think I am $1?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)(.*) are (.*)").unwrap(),
                    responses: vec![
                        "Did you think they might not be $2?".to_string(),
                        "Would you like it if they were not $2?".to_string(),
                        "What if they were not $2?".to_string(),
                        "Possibly they are $2.".to_string(),
                    ],
                },
            ],
        },
        ElizaPattern {
            keyword: "your".to_string(),
            weight: 0,
            rules: vec![ElizaRule {
                pattern: Regex::new(r"(?i)your (.*)").unwrap(),
                responses: vec![
                    "Why are you concerned over my $1?".to_string(),
                    "What about your own $1?".to_string(),
                    "Are you worried about someone else's $1?".to_string(),
                    "Really, my $1?".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "was".to_string(),
            weight: 2,
            rules: vec![
                ElizaRule {
                    pattern: Regex::new(r"(?i)was i (.*)").unwrap(),
                    responses: vec![
                        "What if you were $1?".to_string(),
                        "Do you think you were $1?".to_string(),
                        "Were you $1?".to_string(),
                        "What would it mean if you were $1?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)i was (.*)").unwrap(),
                    responses: vec![
                        "Were you really?".to_string(),
                        "Why do you tell me you were $1 now?".to_string(),
                        "Perhaps I already know you were $1.".to_string(),
                    ],
                },
            ],
        },
        ElizaPattern {
            keyword: "i".to_string(),
            weight: 0,
            rules: vec![
                ElizaRule {
                    pattern: Regex::new(r"(?i)i (?:desire|want|need) (.*)").unwrap(),
                    responses: vec![
                        "What would it mean to you if you got $1?".to_string(),
                        "Why do you want $1?".to_string(),
                        "Suppose you got $1 soon?".to_string(),
                        "What if you never got $1?".to_string(),
                        "What would getting $1 mean to you?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)i am (?:sad|depressed|unhappy|sick)").unwrap(),
                    responses: vec![
                        "I am sorry to hear that you are feeling that way.".to_string(),
                        "Do you think coming here will help you?".to_string(),
                        "I'm sure it's not pleasant to feel that way.".to_string(),
                        "Can you explain what made you feel this way?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)i am (?:happy|elated|glad|joyful)").unwrap(),
                    responses: vec![
                        "How have I helped you to feel this way?".to_string(),
                        "What makes you feel this way just now?".to_string(),
                        "Can you explain why you are suddenly feeling this way?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)i (?:believe|think) (.*)").unwrap(),
                    responses: vec![
                        "Do you really think so?".to_string(),
                        "But you are not sure?".to_string(),
                        "Do you really doubt that?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)i (?:feel|felt) (.*)").unwrap(),
                    responses: vec![
                        "Tell me more about such feelings.".to_string(),
                        "Do you often feel $1?".to_string(),
                        "Do you enjoy feeling $1?".to_string(),
                        "Of what does feeling $1 remind you?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)i can'?t (.*)").unwrap(),
                    responses: vec![
                        "How do you know that you can't $1?".to_string(),
                        "Have you tried?".to_string(),
                        "Perhaps you could $1 now.".to_string(),
                        "Do you really want to be able to $1?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)i don'?t (.*)").unwrap(),
                    responses: vec![
                        "Don't you really $1?".to_string(),
                        "Why don't you $1?".to_string(),
                        "Do you wish to be able to $1?".to_string(),
                        "Does that trouble you?".to_string(),
                    ],
                },
            ],
        },
        ElizaPattern {
            keyword: "you".to_string(),
            weight: 0,
            rules: vec![
                ElizaRule {
                    pattern: Regex::new(r"(?i)you remind me of (.*)").unwrap(),
                    responses: vec![
                        "What makes you think of $1?".to_string(),
                        "What resemblance do you see?".to_string(),
                        "What does that similarity suggest to you?".to_string(),
                        "What other connections do you see?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)you are (.*)").unwrap(),
                    responses: vec![
                        "What makes you think I am $1?".to_string(),
                        "Does it please you to believe I am $1?".to_string(),
                        "Do you sometimes wish you were $1?".to_string(),
                        "Perhaps you would like to be $1.".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)you (.*) me").unwrap(),
                    responses: vec![
                        "Why do you think I $1 you?".to_string(),
                        "You like to think I $1 you -- don't you?".to_string(),
                        "What makes you think I $1 you?".to_string(),
                        "Really, I $1 you?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)you (.*)").unwrap(),
                    responses: vec![
                        "We were discussing you -- not me.".to_string(),
                        "Oh, I $1?".to_string(),
                        "You're not really talking about me -- are you?".to_string(),
                        "What are your feelings now?".to_string(),
                    ],
                },
            ],
        },
        ElizaPattern {
            keyword: "can".to_string(),
            weight: 0,
            rules: vec![
                ElizaRule {
                    pattern: Regex::new(r"(?i)can you (.*)").unwrap(),
                    responses: vec![
                        "You believe I can $1 don't you?".to_string(),
                        "You want me to be able to $1.".to_string(),
                        "Perhaps you would like to be able to $1 yourself.".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)can i (.*)").unwrap(),
                    responses: vec![
                        "Whether or not you can $1 depends on you more than on me.".to_string(),
                        "Do you want to be able to $1?".to_string(),
                        "Perhaps you don't want to $1.".to_string(),
                    ],
                },
            ],
        },
        ElizaPattern {
            keyword: "my".to_string(),
            weight: 2,
            rules: vec![
                ElizaRule {
                    pattern: Regex::new(
                        r"(?i)my (?:mother|mom|father|dad|sister|brother|wife|husband|child)",
                    )
                    .unwrap(),
                    responses: vec![
                        "Tell me more about your family.".to_string(),
                        "Who else in your family concerns you?".to_string(),
                        "What else comes to mind when you think of your family?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)my (.*)").unwrap(),
                    responses: vec![
                        "Your $1?".to_string(),
                        "Why do you say your $1?".to_string(),
                        "Does that suggest anything else which belongs to you?".to_string(),
                        "Is it important to you that your $1?".to_string(),
                    ],
                },
            ],
        },
        ElizaPattern {
            keyword: "yes".to_string(),
            weight: 0,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "You seem quite positive.".to_string(),
                    "You are sure.".to_string(),
                    "I see.".to_string(),
                    "I understand.".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "no".to_string(),
            weight: 0,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "Are you saying 'no' just to be negative?".to_string(),
                    "You are being a bit negative.".to_string(),
                    "Why not?".to_string(),
                    "Why 'no'?".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "why".to_string(),
            weight: 0,
            rules: vec![
                ElizaRule {
                    pattern: Regex::new(r"(?i)why don'?t you (.*)").unwrap(),
                    responses: vec![
                        "Do you believe I don't $1?".to_string(),
                        "Perhaps I will $1 in good time.".to_string(),
                        "Should you $1 yourself?".to_string(),
                        "You want me to $1?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r"(?i)why can'?t i (.*)").unwrap(),
                    responses: vec![
                        "Do you think you should be able to $1?".to_string(),
                        "Do you want to be able to $1?".to_string(),
                        "Do you believe this will help you to $1?".to_string(),
                        "Have you any idea why you can't $1?".to_string(),
                    ],
                },
                ElizaRule {
                    pattern: Regex::new(r".*").unwrap(),
                    responses: vec![
                        "Why do you ask?".to_string(),
                        "Does that question interest you?".to_string(),
                        "What is it you really want to know?".to_string(),
                        "Are such questions much on your mind?".to_string(),
                    ],
                },
            ],
        },
        ElizaPattern {
            keyword: "what".to_string(),
            weight: 0,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "Why do you ask?".to_string(),
                    "Does that question interest you?".to_string(),
                    "What is it you really want to know?".to_string(),
                    "Are such questions much on your mind?".to_string(),
                    "What answer would please you most?".to_string(),
                    "What do you think?".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "because".to_string(),
            weight: 0,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "Is that the real reason?".to_string(),
                    "Don't any other reasons come to mind?".to_string(),
                    "Does that reason seem to explain anything else?".to_string(),
                    "What other reasons might there be?".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "everyone".to_string(),
            weight: 2,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "Really, everyone?".to_string(),
                    "Surely not everyone.".to_string(),
                    "Can you think of anyone in particular?".to_string(),
                    "Who, for example?".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "always".to_string(),
            weight: 1,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "Can you think of a specific example?".to_string(),
                    "When?".to_string(),
                    "What incident are you thinking of?".to_string(),
                    "Really, always?".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "alike".to_string(),
            weight: 10,
            rules: vec![ElizaRule {
                pattern: Regex::new(r".*").unwrap(),
                responses: vec![
                    "In what way?".to_string(),
                    "What resemblance do you see?".to_string(),
                    "What does that similarity suggest to you?".to_string(),
                    "What other connections do you see?".to_string(),
                    "How?".to_string(),
                ],
            }],
        },
        ElizaPattern {
            keyword: "like".to_string(),
            weight: 10,
            rules: vec![ElizaRule {
                pattern: Regex::new(r"(?i).*(?:am|is|are|was) like.*").unwrap(),
                responses: vec![
                    "In what way?".to_string(),
                    "What resemblance do you see?".to_string(),
                    "What does that similarity suggest to you?".to_string(),
                    "What other connections do you see?".to_string(),
                    "How?".to_string(),
                ],
            }],
        },
    ]
}
