"use client";

import { BrandCard, CornerBrackets, Image, SectionLabel } from "@elizaos/cloud-ui";
import { ChevronRight, MessageSquare, MoreVertical } from "lucide-react";

const Agents = () => {
  return (
    <section className="w-full py-12 md:py-20 lg:py-32 bg-[#0A0A0A] relative">
      <div className="container mx-auto px-4 md:px-6">
        {/* Community Agents Showcase */}
        <AgentsShowcase />
      </div>
    </section>
  );
};

const communityAgents = [
  {
    id: 1,
    name: "Ember",
    image: "/agents/agent-1.png",
    traits: ["Curious", "Sharp", "In tune"],
    description: "Guides self-growth and burnout recovery",
    comments: 156,
  },
  {
    id: 2,
    name: "Sol",
    image: "/agents/agent-2.png",
    traits: ["Curious", "Sharp", "In tune"],
    description: "Knows the arts and everything pop culture",
    comments: 156,
  },
  {
    id: 3,
    name: "Pixel",
    image: "/agents/agent-3.png",
    traits: ["Curious", "Sharp", "In tune"],
    description: "Optimizes e-commerce and UX with intuition",
    comments: 156,
  },
];

function AgentsShowcase() {
  return (
    <div className="relative mt-16 md:mt-24 lg:mt-32">
      {/* Corner brackets - hidden on mobile */}
      <div className="hidden md:block">
        <CornerBrackets size="xl" variant="full-border" />
      </div>

      <div className="mx-auto max-w-7xl px-4 md:px-2 py-6 md:py-8 lg:py-12">
        {/* Header */}
        <div className="mb-6 md:mb-8 flex items-center justify-between">
          <SectionLabel>From the Community</SectionLabel>
          <button className="flex items-center gap-2 text-sm md:text-base text-white/70 hover:text-white transition-colors">
            Explore All
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* Agent cards grid */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {communityAgents.map((agent) => (
            <BrandCard
              key={agent.id}
              corners={false}
              hover
              className="overflow-hidden p-0 cursor-pointer"
            >
              {/* Agent image */}
              <div className="relative aspect-[4/3] overflow-hidden">
                <Image
                  src={agent.image}
                  alt={agent.name}
                  fill
                  className="object-cover object-top transition-transform duration-300 group-hover:scale-105"
                />
                {/* Orange filter overlay - hidden by default, shows on hover */}
                <div
                  className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100 z-10"
                  style={{ backgroundColor: "#FF580080" }}
                />
                {/* Gradient overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent z-10" />
              </div>

              {/* Agent info */}
              <div className="p-6">
                <div className="mb-3 flex items-start justify-between">
                  <h3 className="text-2xl font-semibold text-white">{agent.name}</h3>
                  <div className="flex items-center gap-3 text-white/60">
                    <div className="flex items-center gap-1.5">
                      <MessageSquare className="h-4 w-4" />
                      <span className="text-sm">{agent.comments}</span>
                    </div>
                    <button className="transition-colors hover:text-white">
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-white/60">
                  {agent.traits.map((trait, index) => (
                    <span key={trait} className="flex items-center">
                      {trait}
                      {index < agent.traits.length - 1 && <span className="mx-2">•</span>}
                    </span>
                  ))}
                </div>
                <p className="text-sm leading-relaxed text-white/60">{agent.description}</p>
              </div>
            </BrandCard>
          ))}
        </div>
      </div>
    </div>
  );
}

export default Agents;
