import { ReactNode, useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Sun, Moon, LayoutGrid } from 'lucide-react'

interface LayoutProps {
  children: ReactNode
}

export function Layout({ children }: LayoutProps) {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [isDark])

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-3">
              <LayoutGrid className="w-6 h-6" />
              <h1 className="text-lg font-semibold">SkillsBench Metrics</h1>
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant={!isDark ? 'secondary' : 'ghost'}
                size="icon"
                onClick={() => setIsDark(false)}
                title="Light mode"
              >
                <Sun className="w-4 h-4" />
              </Button>
              <Button
                variant={isDark ? 'secondary' : 'ghost'}
                size="icon"
                onClick={() => setIsDark(true)}
                title="Dark mode"
              >
                <Moon className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {children}
      </main>
    </div>
  )
}
