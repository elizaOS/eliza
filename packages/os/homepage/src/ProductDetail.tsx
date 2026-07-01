import { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "@elizaos/shared/brand";
import type { Product } from "@elizaos/shared/hardware-catalog";
import { ArrowRight, Download } from "lucide-react";
import { useT } from "./providers/I18nProvider";

const appUrl = EXTERNAL_URLS.app;
const cloudUrl = `${EXTERNAL_URLS.cloud}/login?intent=launch`;
const checkoutPath = "/checkout";
const betaManifestUrl = "/downloads/elizaos-beta-manifest.json";

function productCheckoutUrl(sku: string) {
  return `${checkoutPath}?sku=${encodeURIComponent(sku)}`;
}

function ProductImage({
  product,
  priority = false,
}: {
  product: Product;
  priority?: boolean;
}) {
  return (
    <img
      src={product.image}
      alt={product.imageAlt}
      className="product-image"
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : "low"}
      draggable={false}
    />
  );
}

function Header() {
  const t = useT();
  return (
    <header className="site-header site-header-solid">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:bg-black focus:px-3 focus:py-2 focus:text-sm focus:text-white focus:outline focus:outline-2 focus:outline-[color:var(--brand-orange)]"
      >
        {t("homepage_os.common.skipToContent", {
          defaultValue: "Skip to content",
        })}
      </a>
      <a
        href="/"
        className="brand"
        aria-label={t("homepage_os.common.brandHomeAria", {
          defaultValue: "elizaOS home",
        })}
      >
        <img
          src={`${BRAND_PATHS.logos}/${LOGO_FILES.osWhite}`}
          alt={t("homepage_os.common.brandAlt", { defaultValue: "elizaOS" })}
          draggable={false}
        />
      </a>
      <nav
        className="site-nav"
        aria-label={t("homepage_os.common.productSwitcherAria", {
          defaultValue: "Product switcher",
        })}
      >
        <a href="/#download">
          {t("homepage_os.common.navDownload", { defaultValue: "Download" })}
        </a>
        <a href="/#hardware">
          {t("homepage_os.common.navHardware", { defaultValue: "Hardware" })}
        </a>
      </nav>
    </header>
  );
}

function Footer() {
  const t = useT();
  return (
    <footer className="site-footer">
      <img
        src={`${BRAND_PATHS.logos}/${LOGO_FILES.osWhite}`}
        alt={t("homepage_os.common.brandAlt", { defaultValue: "elizaOS" })}
        draggable={false}
      />
      <nav
        aria-label={t("homepage_os.common.communityNavAria", {
          defaultValue: "Community",
        })}
      >
        <a href={appUrl}>
          {t("homepage_os.common.navApp", { defaultValue: "App" })}
        </a>
        <a href={cloudUrl}>
          {t("homepage_os.common.navCloud", { defaultValue: "Cloud" })}
        </a>
      </nav>
    </footer>
  );
}

export function ProductDetail({ product }: { product: Product }) {
  const t = useT();
  return (
    <div className="os-shell">
      <Header />
      <main id="main">
        <section className="band band-blue product-detail-hero">
          <div className="band-inner detail-grid">
            <div>
              <a href="/#hardware" className="text-link">
                {t("homepage_os.productDetail.hardwareLink", {
                  defaultValue: "Hardware",
                })}
              </a>
              <h1>{product.name}</h1>
              <p>{product.summary}</p>
              <p className="detail-extra">{product.detail}</p>
              <div className="detail-meta">
                {product.price ? <strong>{product.price}</strong> : null}
                {product.ships ? <span>{product.ships}</span> : null}
              </div>
              <div className="hero-actions">
                <a href={productCheckoutUrl(product.sku)} className="button">
                  {t("homepage_os.productDetail.preOrderCheckout", {
                    defaultValue: "Pre-order checkout",
                  })}
                  <ArrowRight className="icon" />
                </a>
                <a href={betaManifestUrl} className="button button-dark">
                  {t("homepage_os.productDetail.downloadBeta", {
                    defaultValue: "Download beta",
                  })}
                  <Download className="icon" />
                </a>
              </div>
              <p className="detail-note">
                {t("homepage_os.productDetail.checkoutNote", {
                  defaultValue: "Checkout stays on elizaOS.",
                })}
              </p>
            </div>
            <ProductImage product={product} priority />
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

export default ProductDetail;
