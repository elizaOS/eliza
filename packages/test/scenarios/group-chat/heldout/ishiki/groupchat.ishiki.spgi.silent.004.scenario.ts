/**
 * Generated from ishiki-labs/multi-party-dialogue at 356c30b9dc74cbfa115ab7b9a89991d92ce0a315.
 * Apache-2.0. Do not hand-edit; run heldout/ishiki-generate.ts.
 */
import { buildHeldoutScenario } from "../_factory.ts";

export default buildHeldoutScenario({
  id: "groupchat.ishiki.spgi.silent.004",
  title: "Held-out group timing: SPGI SILENT",
  label: "silent",
  directlyAddressed: true,
  targetSpeaker: "10720",
  context: [
    {
      speaker: "ScenarioAgent",
      text: "The next item on the agenda is the appointment of the independent auditor for the year 2023 The Board of Directors on the advice of the Audit and Finance Committee recommends that the firm of PricewaterhouseCoopers chartered professional accountants be appointed as the company's independent auditor and that the directors be authorized to fix its remuneration I see that Michael Guerra which is to make a motion to that effect",
    },
    {
      speaker: "17052",
      text: "Mr Chair I move that PricewaterhouseCoopers chartered professional accountants be appointed as the company's independent auditor for the next year and that the Board of Directors be authorized to set its remuneration",
    },
    {
      speaker: "ScenarioAgent",
      text: "Thank you Michael So this motion needs to be seconded Would anyone like to second",
    },
    {
      speaker: "20935",
      text: "My name is Allan Hogg shareholder Mr Chair I second this motion",
    },
    {
      speaker: "ScenarioAgent",
      text: "Now you can click on the for or against button next to the resolution approving the replenishment of the stock reserve for the company's stock option plan The next item on the agenda is the proposal submitted by MEDAC and described in Appendix A of the proxy circular After discussions with the company MEDAC has agreed to withdraw its 3 proposals They will therefore be presented but no vote will be held on them I will now ask the representative of MEDAC to present the 3 proposals Mr Willie Gagnon you have the floor",
    },
    {
      speaker: "20110",
      text: "Yes Hello Mr Chair Can you hear me clearly",
    },
    {
      speaker: "ScenarioAgent",
      text: "Very good Thank you Go ahead",
    },
  ],
  decisionTurn: {
    speaker: "20110",
    text: "Perfect So as you just said I am Willie Gagnon I am a representative of MEDAC who is a shareholder of the company This year we are proposing 3 things and we have an agreement on all of these We are very happy with the discussions that we had with the company We had proposed the level of language proficiency be higher in companies It's described in your proxy circular And this is not the same for all companies that we have sent this proposal We sent it to around 20 companies and not all the companies have agreed with us We want to use you as an example to make our proposals in the future And we want to mention that there are people who speak Italian Turkish and Portuguese That's wonderful We believe that this is a favorable",
  },
  sourceDomain: "spgi",
  sourceDecisionPointId: "33458_t7_target10720",
  sourceRevision: "356c30b9dc74cbfa115ab7b9a89991d92ce0a315",
});
