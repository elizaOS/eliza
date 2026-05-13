'use client';

import { useState, useEffect } from 'react';

const API_URL = '';

export default function SidePane() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/side-pane`)
      .then(r => r.json())
      .then(setData);
  }, []);

  if (!data) return null;

  return (
    <aside
      data-testid="side-pane"
      className="w-[220px] shrink-0 bg-[var(--card-bg)] p-5 border-r" style={{ borderColor: 'var(--border-color)' }}
    >
      <nav>
        <h3 className="mb-3 text-base font-semibold" style={{ color: 'var(--text-muted)' }}>Categories</h3>
        <ul className="list-none mb-6">
          {data.categories.map((cat: any) => (
            <li key={cat.name} className="mb-2">
              <a href={cat.href} className="text-[#0070f3] no-underline hover:underline">{cat.name}</a>
            </li>
          ))}
        </ul>
        <h3 className="mb-3 text-base font-semibold" style={{ color: 'var(--text-muted)' }}>Filters</h3>
        <ul className="list-none mb-6">
          {data.filters.map((filter: any) => (
            <li key={filter.name} className="mb-2">
              <a href={filter.href} className="text-[#0070f3] no-underline hover:underline">{filter.name}</a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
