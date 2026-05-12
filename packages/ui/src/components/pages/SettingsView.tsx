import { cn } from "../../lib/utils";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { PagePanel } from "../composites/page-panel";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { useLinkedSidebarSelection } from "../../hooks/useLinkedSidebarSelection";
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApp } from "../../state";
import {
  readSettingsHashSection,
  replaceSettingsHash,
  SECTION_TONE_ICON_CLASS,
  SETTINGS_SECTIONS,
  type SettingsSectionDef,
  settingsSectionLabel,
  settingsSectionTitle,
  settingsSectionTooltip,
} from "../settings/settings-sections";
import { AppPageSidebar } from "../shared/AppPageSidebar";

const SETTINGS_CONTENT_CLASS =
  "[scroll-padding-top:7rem] [scrollbar-gutter:stable] scroll-smooth bg-bg/10 pb-4 pt-2 sm:pb-6 sm:pt-3";
const SETTINGS_CONTENT_WIDTH_CLASS = "w-full min-h-0";
const SETTINGS_SECTION_STACK_CLASS = "space-y-3 pb-10 sm:space-y-4";

interface SettingsSectionProps extends ComponentPropsWithoutRef<"section"> {
  title?: string;
  bodyClassName?: string;
}

const SettingsSection = forwardRef<HTMLElement, SettingsSectionProps>(
  function SettingsSection(
    { title, bodyClassName, className, children, ...props },
    ref,
  ) {
    if (title) {
      return (
        <PagePanel.CollapsibleSection
          ref={ref}
          as="section"
          expanded
          variant="section"
          heading={title}
          headingClassName="text-base sm:text-lg font-semibold tracking-tight text-txt-strong"
          bodyClassName={cn("px-4 pb-3 pt-0 sm:px-5 sm:pb-4", bodyClassName)}
          className={cn("rounded-2xl", className)}
          {...props}
        >
          {children}
        </PagePanel.CollapsibleSection>
      );
    }

    return (
      <section
        ref={ref}
        data-content-align-offset={4}
        className={className}
        {...props}
      >
        <PagePanel variant="section">
          <div className={cn("p-4 sm:p-5", bodyClassName)}>{children}</div>
        </PagePanel>
      </section>
    );
  },
);

export function SettingsView({
  inModal,
  onClose: _onClose,
  initialSection,
}: {
  inModal?: boolean;
  onClose?: () => void;
  initialSection?: string;
} = {}) {
  const { t, loadPlugins, walletEnabled } = useApp();
  const [activeSection, setActiveSection] = useState(
    () => initialSection ?? readSettingsHashSection() ?? "identity",
  );
  const shellRef = useRef<HTMLDivElement>(null);
  const initialAlignmentPendingRef = useRef(true);
  const scrollSelectionSuppressionTimerRef = useRef<number | null>(null);

  const suppressScrollSelection = useCallback((durationMs = 700) => {
    if (typeof window === "undefined") return;
    initialAlignmentPendingRef.current = true;
    if (scrollSelectionSuppressionTimerRef.current != null) {
      window.clearTimeout(scrollSelectionSuppressionTimerRef.current);
    }
    scrollSelectionSuppressionTimerRef.current = window.setTimeout(() => {
      initialAlignmentPendingRef.current = false;
      scrollSelectionSuppressionTimerRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (
        typeof window !== "undefined" &&
        scrollSelectionSuppressionTimerRef.current != null
      ) {
        window.clearTimeout(scrollSelectionSuppressionTimerRef.current);
      }
    };
  }, []);

  const visibleSections = useMemo(() => {
    return SETTINGS_SECTIONS.filter((section) => {
      if (section.id === "wallet-rpc" && walletEnabled === false) return false;
      return true;
    });
  }, [walletEnabled]);
  const visibleSectionIds = useMemo(
    () => new Set(visibleSections.map((section) => section.id)),
    [visibleSections],
  );
  const {
    contentContainerRef,
    queueContentAlignment,
    registerContentItem,
    registerSidebarItem,
  } = useLinkedSidebarSelection<string>({
    contentTopOffset: 24,
    enabled: visibleSections.length > 0,
    selectedId: visibleSectionIds.has(activeSection) ? activeSection : null,
    topAlignedId: visibleSections[0]?.id ?? null,
  });

  const alignContentToSection = useCallback(
    (sectionId: string): boolean => {
      const root = contentContainerRef.current;
      const shell = shellRef.current;
      const target = shell?.querySelector(`#${sectionId}`);
      if (!(root instanceof HTMLElement) || !(target instanceof HTMLElement)) {
        return false;
      }

      const rootRect = root.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      root.scrollTo({
        top: root.scrollTop + targetRect.top - rootRect.top - 24,
        behavior: "auto",
      });
      return true;
    },
    [contentContainerRef],
  );

  const queueSectionAlignment = useCallback(
    (sectionId: string) => {
      suppressScrollSelection();
      queueContentAlignment(sectionId);
      if (typeof window === "undefined") return;
      window.requestAnimationFrame(() => {
        if (!alignContentToSection(sectionId)) {
          window.setTimeout(() => alignContentToSection(sectionId), 50);
        }
      });
    },
    [alignContentToSection, queueContentAlignment, suppressScrollSelection],
  );

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const handleSectionChange = useCallback(
    (sectionId: string) => {
      setActiveSection(sectionId);
      replaceSettingsHash(sectionId);
      queueSectionAlignment(sectionId);
    },
    [queueSectionAlignment],
  );

  useEffect(() => {
    if (visibleSections.length === 0) return;
    if (!visibleSectionIds.has(activeSection)) {
      setActiveSection(visibleSections[0].id);
    }
  }, [activeSection, visibleSectionIds, visibleSections]);

  useEffect(() => {
    if (!initialAlignmentPendingRef.current) return;
    if (!visibleSectionIds.has(activeSection)) return;
    queueSectionAlignment(activeSection);
  }, [activeSection, queueSectionAlignment, visibleSectionIds]);

  useEffect(() => {
    if (!initialSection) return;
    handleSectionChange(initialSection);
  }, [handleSectionChange, initialSection]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleHashChange = () => {
      const nextSection = readSettingsHashSection();
      if (!nextSection || !visibleSectionIds.has(nextSection)) return;
      handleSectionChange(nextSection);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [handleSectionChange, visibleSectionIds]);

  useEffect(() => {
    const shell = shellRef.current;
    const root = contentContainerRef.current;
    if (!shell || !root) return;

    const handleScroll = () => {
      if (initialAlignmentPendingRef.current) return;

      const sections = visibleSections
        .map((section) => {
          const el = shell.querySelector(`#${section.id}`);
          return { id: section.id, el };
        })
        .filter(
          (section): section is { id: string; el: HTMLElement } =>
            section.el instanceof HTMLElement,
        );

      if (sections.length === 0) return;

      const rootRect = root.getBoundingClientRect();
      const activeAnchorOffset = Math.min(
        320,
        Math.max(180, root.clientHeight * 0.35),
      );
      let currentSection = sections[0].id;

      for (const { id, el } of sections) {
        const elRect = el.getBoundingClientRect();
        if (elRect.top - rootRect.top <= activeAnchorOffset) {
          currentSection = id;
        }
      }

      setActiveSection((prev) => {
        if (prev === currentSection) return prev;
        replaceSettingsHash(currentSection);
        return currentSection;
      });
    };

    root.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();

    return () => root.removeEventListener("scroll", handleScroll);
  }, [contentContainerRef, visibleSections]);

  const activeSectionDef: SettingsSectionDef | null =
    visibleSections.find((section) => section.id === activeSection) ??
    SETTINGS_SECTIONS.find((section) => section.id === activeSection) ??
    visibleSections[0] ??
    null;

  const settingsSidebar = (
    <AppPageSidebar
      testId="settings-sidebar"
      collapsible
      resizable
      contentIdentity="settings"
      collapseButtonTestId="settings-sidebar-collapse-toggle"
      expandButtonTestId="settings-sidebar-expand-toggle"
      collapseButtonAriaLabel="Collapse settings"
      expandButtonAriaLabel="Expand settings"
      mobileTitle={t("nav.settings")}
      mobileMeta={
        activeSectionDef ? settingsSectionLabel(activeSectionDef, t) : undefined
      }
    >
      <SidebarScrollRegion className="pt-0">
        <SidebarPanel>
          <nav className="space-y-1.5" aria-label={t("nav.settings")}>
            {visibleSections.map((section) => {
              const isActive = activeSection === section.id;
              const Icon = section.icon;
              const toneClass = SECTION_TONE_ICON_CLASS[section.tone];
              const tooltip = settingsSectionTooltip(section, t);
              return (
                <SidebarContent.Item
                  key={section.id}
                  as="div"
                  active={isActive}
                  className="gap-2 py-2"
                  ref={registerSidebarItem(section.id)}
                >
                  <SidebarContent.ItemButton
                    onClick={() => handleSectionChange(section.id)}
                    aria-current={isActive ? "page" : undefined}
                    className="items-center gap-2.5"
                    title={tooltip}
                  >
                    <SidebarContent.ItemIcon
                      active={isActive}
                      className={cn(
                        "mt-0 h-8 w-8 rounded-lg p-1.5",
                        !isActive && toneClass,
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden />
                    </SidebarContent.ItemIcon>
                    <SidebarContent.ItemBody>
                      <SidebarContent.ItemTitle
                        className={cn(
                          "text-sm leading-5",
                          isActive ? "font-semibold" : "font-medium",
                        )}
                      >
                        {settingsSectionLabel(section, t)}
                      </SidebarContent.ItemTitle>
                    </SidebarContent.ItemBody>
                  </SidebarContent.ItemButton>
                </SidebarContent.Item>
              );
            })}
          </nav>
        </SidebarPanel>
      </SidebarScrollRegion>
    </AppPageSidebar>
  );

  return (
    <PageLayout
      className={cn("h-full", inModal && "min-h-0")}
      data-testid="settings-shell"
      sidebar={settingsSidebar}
      contentRef={contentContainerRef}
      contentClassName={SETTINGS_CONTENT_CLASS}
      contentInnerClassName={SETTINGS_CONTENT_WIDTH_CLASS}
      mobileSidebarLabel={
        activeSectionDef
          ? settingsSectionLabel(activeSectionDef, t)
          : t("nav.settings")
      }
    >
      <div ref={shellRef} className={`w-full ${SETTINGS_SECTION_STACK_CLASS}`}>
        {visibleSections.map((section) => {
          const Component = section.Component;
          return (
            <SettingsSection
              key={section.id}
              id={section.id}
              title={settingsSectionTitle(section, t)}
              bodyClassName={section.bodyClassName}
              ref={registerContentItem(section.id)}
            >
              <Component />
            </SettingsSection>
          );
        })}
      </div>
    </PageLayout>
  );
}
