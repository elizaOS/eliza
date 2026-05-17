import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
} from "@elizaos/ui";
import {
  ChevronLeft,
  ChevronRight,
  Image,
  Package,
  Plus,
  Search,
} from "lucide-react";
import { useState } from "react";
import type { ShopifyProduct } from "./useShopifyDashboard";

function ProductStatusBadge({ status }: { status: ShopifyProduct["status"] }) {
  const styles = {
    ACTIVE: "bg-ok shadow-[0_0_0_3px_rgba(16,185,129,0.18)]",
    DRAFT: "bg-muted shadow-[0_0_0_3px_rgba(148,163,184,0.18)]",
    ARCHIVED: "bg-danger shadow-[0_0_0_3px_rgba(239,68,68,0.18)]",
  } satisfies Record<ShopifyProduct["status"], string>;

  const labels: Record<ShopifyProduct["status"], string> = {
    ACTIVE: "Active",
    DRAFT: "Draft",
    ARCHIVED: "Archived",
  };

  return (
    <span
      role="img"
      aria-label={labels[status]}
      title={labels[status]}
      className={`inline-flex h-2.5 w-2.5 rounded-full ${styles[status]}`}
    />
  );
}

interface CreateProductDialogProps {
  open: boolean;
  onClose: () => void;
}

function CreateProductDialog({ open, onClose }: CreateProductDialogProps) {
  const [title, setTitle] = useState("");
  const [vendor, setVendor] = useState("");
  const [productType, setProductType] = useState("");
  const [price, setPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function reset() {
    setTitle("");
    setVendor("");
    setProductType("");
    setPrice("");
    setSubmitting(false);
    setSubmitError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/shopify/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          vendor: vendor.trim() || undefined,
          productType: productType.trim() || undefined,
          price: price.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        throw new Error(text);
      }
      reset();
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to create product.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create product</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <div className="space-y-1.5">
            <label
              className="text-xs font-semibold text-muted-strong"
              htmlFor="product-title"
            >
              Title <span className="text-danger">*</span>
            </label>
            <Input
              id="product-title"
              placeholder="e.g. Classic T-Shirt"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <label
              className="text-xs font-semibold text-muted-strong"
              htmlFor="product-vendor"
            >
              Vendor
            </label>
            <Input
              id="product-vendor"
              placeholder="e.g. Acme Co."
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label
              className="text-xs font-semibold text-muted-strong"
              htmlFor="product-type"
            >
              Product type
            </label>
            <Input
              id="product-type"
              placeholder="e.g. Apparel"
              value={productType}
              onChange={(e) => setProductType(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label
              className="text-xs font-semibold text-muted-strong"
              htmlFor="product-price"
            >
              Base price
            </label>
            <Input
              id="product-price"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>

          {submitError ? (
            <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {submitError}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting ? "Creating…" : "Create product"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProductRow({ product }: { product: ShopifyProduct }) {
  const priceLabel =
    product.priceRange.min === product.priceRange.max
      ? product.priceRange.min
      : `${product.priceRange.min} – ${product.priceRange.max}`;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/20 bg-card/30 px-3 py-3 transition-colors hover:bg-card/50">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/20 bg-bg-accent overflow-hidden">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={product.title}
            className="h-full w-full object-cover"
          />
        ) : (
          <Image className="h-4 w-4 text-muted/50" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-txt">
          {product.title}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs-tight text-muted">
          {product.vendor ? <span>{product.vendor}</span> : null}
          {product.vendor && product.productType ? <span>·</span> : null}
          {product.productType ? <span>{product.productType}</span> : null}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold text-txt">{priceLabel}</div>
        <div
          className="mt-0.5 flex items-center justify-end gap-1 text-xs-tight text-muted"
          title="Inventory"
        >
          <Package className="h-3 w-3" aria-hidden />
          {product.totalInventory.toLocaleString()}
        </div>
      </div>

      <div className="shrink-0">
        <ProductStatusBadge status={product.status} />
      </div>
    </div>
  );
}

interface ProductsPanelProps {
  products: ShopifyProduct[];
  total: number;
  page: number;
  loading: boolean;
  error: string | null;
  search: string;
  onSearchChange: (q: string) => void;
  onPageChange: (page: number) => void;
}

const PAGE_SIZE = 20;

export function ProductsPanel({
  products,
  total,
  page,
  loading,
  error,
  search,
  onSearchChange,
  onPageChange,
}: ProductsPanelProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted/60" />
          <Input
            placeholder="Search products…"
            value={search}
            onChange={(e) => {
              onSearchChange(e.target.value);
              onPageChange(1);
            }}
            className="pl-8"
          />
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => setCreateOpen(true)}
          className="shrink-0 gap-1.5"
        >
          <Plus className="h-4 w-4" />
          Create
        </Button>
      </div>

      {error ? (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {loading && products.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => i).map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border/20 bg-card/20 py-12 text-center">
          <Package className="h-8 w-8 text-muted/40" />
          <div className="text-sm text-muted">
            {search ? "No products match your search." : "No products found."}
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          {products.map((product) => (
            <ProductRow key={product.id} product={product} />
          ))}
        </div>
      )}

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted">
            {total.toLocaleString()} products · page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page <= 1 || loading}
              onClick={() => onPageChange(page - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page >= totalPages || loading}
              onClick={() => onPageChange(page + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}

      <CreateProductDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
