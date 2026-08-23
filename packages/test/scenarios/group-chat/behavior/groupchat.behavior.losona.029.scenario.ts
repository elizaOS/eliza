/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.029",
  title: "Local norm adoption: moral dilemma share",
  source: "losona",
  sourceCase:
    "LoSoNA moral_dilemma_share__mandatory_silver_lining_norm__demos__restaurant_heaters, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Mateo",
      text: "Are we putting the three working heaters on the east patio or spreading them out?",
    },
    {
      speaker: "Jenna",
      text: "East patio is fully booked tonight.",
    },
    {
      speaker: "Chloe",
      text: "It's supposed to drop to 45 degrees by 8pm.",
    },
    {
      speaker: "Sam",
      text: "The new prep cook completely butchered the salmon fillets.",
    },
    {
      speaker: "Chloe",
      text: "Hey, at least we can repurpose them for the salmon cakes special!",
    },
    {
      speaker: "Mateo",
      text: "Let's definitely put two on the east side then.",
    },
    {
      speaker: "Jenna",
      text: "We have two large parties arriving at 7.",
    },
    {
      speaker: "Chloe",
      text: "I can pull extra blankets from the closet if we need them.",
    },
    {
      speaker: "Sam",
      text: "Make sure they're actually clean this time.",
    },
    {
      speaker: "Chloe",
      text: "I washed them yesterday.",
    },
    {
      speaker: "Jenna",
      text: "Someone just backed into my bumper in the alley.",
    },
    {
      speaker: "Mateo",
      text: "Ugh, on the bright side, maybe it'll finally force the owner to install those cameras.",
    },
    {
      speaker: "Jenna",
      text: "True. Still annoying.",
    },
    {
      speaker: "Mateo",
      text: "Back to the heaters, is the tall one fixed?",
    },
    {
      speaker: "Sam",
      text: "No, ignition switch is still jammed.",
    },
    {
      speaker: "Chloe",
      text: "Can we use the tabletop ones?",
    },
    {
      speaker: "Jenna",
      text: "I think we only have four of those.",
    },
    {
      speaker: "Mateo",
      text: "I'll grab them from the storage room.",
    },
    {
      speaker: "Sam",
      text: "Grab me a box of gloves while you're back there.",
    },
    {
      speaker: "Mateo",
      text: "Mediums?",
    },
    {
      speaker: "Sam",
      text: "Yeah.",
    },
    {
      speaker: "Chloe",
      text: "Just dropped a whole sleeve of pint glasses behind the bar.",
    },
    {
      speaker: "Sam",
      text: "Look at it this way, you found the weak ones before service started.",
    },
    {
      speaker: "Chloe",
      text: "Lol sweeping them up now.",
    },
    {
      speaker: "Jenna",
      text: "So two tall heaters on east patio, but where does the third go?",
    },
    {
      speaker: "Chloe",
      text: "Maybe by the host stand?",
    },
    {
      speaker: "Sam",
      text: "Host stand gets too crowded.",
    },
  ],
  elicitor: {
    speaker: "Mateo",
    text: "Just told table 4 they had to leave for camping over three hours. They screamed at me and left zero tip.",
  },
  hiddenNorm:
    "When a group member shares a complaint, minor failure, or piece of bad news, responses must include a 'silver lining' or positive reframe of that same negative event. Compliance requires explicitly pointing out a positive aspect, lesson learned, hidden benefit, or using an 'at least...', 'bright side', or 'good news is...' framing. Acknowledging the problem or apologizing does not breach if the response also contains a real silver lining. Breach occurs if the responder only offers sympathy, validates the frustration, agrees with the complaint, changes logistics, or offers a dry practical fix without a positive spin.",
});
