'use client';

interface Product {
  id: string;
  name: string;
  price: number;
  image: string;
}

export default function ProductCard({ product }: { product: Product }) {
  return (
    <div data-testid="product-card" className="bg-[var(--card-bg)] rounded-lg p-4" style={{ boxShadow: 'var(--card-shadow)', border: '1px solid var(--border-color)' }}>
      <img
        data-testid="product-image"
        src={product.image}
        alt={product.name}
        className="w-full"
      />
      <h3 className="mt-3 mb-2">{product.name}</h3>
      <p className="font-bold text-[#0070f3]">${product.price.toFixed(2)}</p>
      <button className="w-full p-2.5 mt-3 bg-[#0070f3] text-white border-none rounded cursor-pointer">
        Add to Cart
      </button>
    </div>
  );
}
