import { Chat } from '@/components/chat';
import { ThemeToggle } from '@/components/theme-toggle';

export default function Home() {
  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar for agent selection (future enhancement) */}
      <aside className="hidden md:flex w-64 border-r bg-muted/10 flex-col">
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Eliza Chat</h2>
            <p className="text-sm text-muted-foreground">AI Agent Interface</p>
          </div>
          <ThemeToggle />
        </div>
        <div className="flex-1 p-4">
          <div className="space-y-2">
            <div className="rounded-lg border bg-background p-3 cursor-pointer hover:bg-accent">
              <div className="font-medium">Default Agent</div>
              <div className="text-sm text-muted-foreground">General purpose assistant</div>
            </div>
          </div>
        </div>
      </aside>
      
      {/* Main chat area */}
      <main className="flex-1 flex flex-col">
        {/* Mobile header */}
        <header className="md:hidden border-b p-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Eliza Chat</h2>
          </div>
          <ThemeToggle />
        </header>
        <div className="flex-1">
          <Chat agentName="Eliza" />
        </div>
      </main>
    </div>
  );
}