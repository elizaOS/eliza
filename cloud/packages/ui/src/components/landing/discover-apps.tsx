"use client";

import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";

interface PlaceholderApp {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  slug: string;
}

const placeholderApps: PlaceholderApp[] = [
  {
    id: "1",
    name: "Iconstack Pro Enterprise Edition",
    description:
      "50,000+ Free SVG Icons for designers, developers, and creative professionals worldwide",
    imageUrl: "/placeholder/app-1.jpg",
    slug: "iconstack",
  },
  {
    id: "2",
    name: "ExamAi",
    description:
      "Create, grade, and analyze your examinations with AI-powered insights and automated feedback",
    imageUrl: "/placeholder/app-2.jpg",
    slug: "examai",
  },
  {
    id: "3",
    name: "Attendflow Event Management Platform",
    description: "Event marketing made simple",
    imageUrl: "/placeholder/app-3.jpg",
    slug: "attendflow",
  },
  {
    id: "4",
    name: "creativable",
    description:
      "All-in-one CRM, AI Assistant, team collaboration, project management, and customer support platform",
    imageUrl: "/placeholder/app-4.jpg",
    slug: "creativable",
  },
  {
    id: "5",
    name: "Opux AI",
    description: "Every successful app starts here",
    imageUrl: "/placeholder/app-5.jpg",
    slug: "opux-ai",
  },
  {
    id: "6",
    name: "NeuroTunes AI",
    description: "Adaptive music streaming engine...",
    imageUrl: "/placeholder/app-6.jpg",
    slug: "neurotunes-ai",
  },
  {
    id: "7",
    name: "Pilates Circle by Cult",
    description: "Move, full circle.",
    imageUrl: "/placeholder/app-7.jpg",
    slug: "pilates-circle",
  },
  {
    id: "8",
    name: "Createspace",
    description: "AI Media Made Simple",
    imageUrl: "/placeholder/app-8.jpg",
    slug: "createspace",
  },
];

function AppCard({ app }: { app: PlaceholderApp }) {
  return (
    <Link to={`/login?intent=signup&app=${encodeURIComponent(app.slug)}`} className="group block">
      {/* Image container */}
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-white/5 border border-white/10 transition-all duration-300 group-hover:border-white/20">
        {/* Image */}
        <div className="absolute inset-0 transition-transform duration-300 group-hover:scale-105">
          <div className="w-full h-full bg-neutral-800 flex items-center justify-center">
            <span className="text-white/20 text-xs">App Preview</span>
          </div>
        </div>
      </div>

      {/* App info */}
      <div className="mt-3">
        <h3 className="text-white font-medium truncate">{app.name}</h3>
        <p className="text-white/50 text-sm truncate mt-0.5">{app.description}</p>
      </div>
    </Link>
  );
}

export default function DiscoverApps() {
  return (
    <section className="w-full px-4 sm:px-6 lg:px-8 py-16 sm:py-24 bg-black">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h2 className="text-2xl sm:text-3xl font-semibold text-white">Discover apps</h2>
            <p className="text-white/50 mt-1">Explore what others are building</p>
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
          {placeholderApps.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      </div>
    </section>
  );
}
