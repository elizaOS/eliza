'use client';

import { useState } from 'react';
import { useTheme } from '@/components/ThemeProvider';
import Banner from '@/components/Banner';
import ProductList from '@/components/ProductList';
import LateBanner from '@/components/LateBanner';
import SidePane from '@/components/SidePane';
import ResultsBar from '@/components/ResultsBar';

export default function Home() {
  const { theme, toggleTheme } = useTheme();
  const [page, setPage] = useState(1);
  const [totalProducts, setTotalProducts] = useState(0);

  return (
    <main>
      <header className="flex justify-between items-center p-5 border-b" style={{ borderColor: 'var(--border-color)' }}>
        <h1 className="text-2xl">Modern Marketplace</h1>
        <button
          data-testid="theme-toggle"
          className="px-4 py-2 border-none rounded bg-[#0070f3] text-white cursor-pointer"
          onClick={toggleTheme}
        >
          {theme === 'light' ? 'Dark Mode' : 'Light Mode'}
        </button>
      </header>
      <Banner />
      <LateBanner />
      <div className="flex">
        <SidePane />
        <div data-testid="main-content" className="flex-1">
          <ResultsBar
            page={page}
            totalProducts={totalProducts}
            onPageChange={setPage}
          />
          <ProductList
            page={page}
            onProductsLoaded={setTotalProducts}
          />
        </div>
      </div>
    </main>
  );
}
