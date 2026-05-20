import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "atlas-logistics",
  name: "Atlas Logistics",
  ticker: "ATLS",
  description:
    "Delivery and logistics platform that optimized the last mile so thoroughly that the humans doing the work wish they were replaced by drones. 3 class-action lawsuits and a Reddit megathread called 'Atlas Logistics Is Hell.'",
  type: "company",
  canBeInvolved: true,
  initialPrice: 175,
  postStyle:
    "Efficiency metrics without human context. Last mile optimization data. Operations research language applied to people. KPI dashboards that forgot humans have needs.",
  postExample: [
    "Optimized.",
    "4.2M deliveries this month.",
    "Efficiency: improved.",
    "The algorithm knows best.",
    "Last mile: conquered. (Driver complaints: filed.)",
  ],
  pfpDescription:
    "A globe logo with delivery route lines wrapping around it. Efficient, global, and oblivious to the humans following those routes.",
  bannerDescription:
    "A real-time delivery map showing thousands of drivers as dots. Each dot is a person. The dashboard treats them as data points. The class-action lawsuit treats them as plaintiffs.",
  username: "atlaslogistics",
} as const satisfies PackOrganization;

export default organization;
