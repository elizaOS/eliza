"use client";

import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";

interface PlaceholderAgent {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  avatarUrl: string;
  username: string;
}

const placeholderAgents: PlaceholderAgent[] = [
  {
    id: "1",
    name: "Ecommerce Store Assistant Pro",
    description: "Premium design for webstore with inventory management and customer support",
    imageUrl: "/placeholder/agent-1.jpg",
    avatarUrl: "/placeholder/avatar-1.png",
    username: "ecommerce-store",
  },
  {
    id: "2",
    name: "Architect portfolio",
    description: "Professional firm website & portfolio showcase for architects and designers",
    imageUrl: "/placeholder/agent-2.jpg",
    avatarUrl: "/placeholder/avatar-2.png",
    username: "architect-portfolio",
  },
  {
    id: "3",
    name: "Personal Blog Writing Assistant",
    description: "Muted, intimate design",
    imageUrl: "/placeholder/agent-3.jpg",
    avatarUrl: "/placeholder/avatar-3.png",
    username: "personal-blog",
  },
  {
    id: "4",
    name: "Fashion blog",
    description:
      "Minimal, playful design with style recommendations and trend analysis capabilities",
    imageUrl: "/placeholder/agent-4.jpg",
    avatarUrl: "/placeholder/avatar-4.png",
    username: "fashion-blog",
  },
  {
    id: "5",
    name: "Visual landing page",
    description: "Showcase your company",
    imageUrl: "/placeholder/agent-5.jpg",
    avatarUrl: "/placeholder/avatar-5.png",
    username: "visual-landing",
  },
  {
    id: "6",
    name: "Lifestyle Blog",
    description: "Sophisticated blog design",
    imageUrl: "/placeholder/agent-6.jpg",
    avatarUrl: "/placeholder/avatar-6.png",
    username: "lifestyle-blog",
  },
  {
    id: "7",
    name: "Event platform",
    description: "Find, register, create events",
    imageUrl: "/placeholder/agent-7.jpg",
    avatarUrl: "/placeholder/avatar-7.png",
    username: "event-platform",
  },
  {
    id: "8",
    name: "Personal portfolio",
    description: "Personal work showcase",
    imageUrl: "/placeholder/agent-8.jpg",
    avatarUrl: "/placeholder/avatar-8.png",
    username: "personal-portfolio",
  },
];

function AgentCard({ agent }: { agent: PlaceholderAgent }) {
  return (
    <Link
      to={`/login?intent=signup&agent=${encodeURIComponent(agent.username)}`}
      className="group block"
    >
      {/* Image container */}
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-white/5 border border-white/10 transition-all duration-300 group-hover:border-white/20">
        {/* Image placeholder */}
        <div className="absolute inset-0 transition-transform duration-300 group-hover:scale-105">
          <div className="w-full h-full bg-neutral-800 flex items-center justify-center">
            <span className="text-white/20 text-xs">Agent Preview</span>
          </div>
        </div>
      </div>

      {/* Agent info */}
      <div className="mt-3 flex items-center gap-3">
        {/* Avatar icon */}
        <div className="w-10 h-10 rounded-full bg-neutral-800 border border-white/10 flex-shrink-0 flex items-center justify-center overflow-hidden">
          <span className="text-white/40 text-xs font-medium">{agent.name.charAt(0)}</span>
        </div>

        {/* Text content */}
        <div className="flex-1 min-w-0">
          <h3 className="text-white font-medium truncate">{agent.name}</h3>
          <p className="text-white/50 text-sm truncate">{agent.description}</p>
        </div>
      </div>
    </Link>
  );
}

export default function DiscoverAgents() {
  return (
    <section className="w-full px-4 sm:px-6 lg:px-8 py-16 sm:py-24 bg-black">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h2 className="text-2xl sm:text-3xl font-semibold text-white">Discover agents</h2>
            <p className="text-white/50 mt-1">Start your next project with a template</p>
          </div>
          <Link
            to="/login?intent=signup"
            className="flex items-center gap-1 text-white/70 hover:text-white transition-colors text-sm sm:text-base"
          >
            View all
            <ChevronRight className="w-4 h-4" />
          </Link>
        </div>

        {/* Grid */}
        <div className="grid gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {placeholderAgents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      </div>
    </section>
  );
}
