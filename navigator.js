// Renders the navigator sidebar from the navigator index that DocC defines in "navigator-index.js".
//
// Each page is a separate document. To keep the navigator's state across pages,
// this script stores which items are open, which item the reader clicked, and the scroll position in the session storage.
(() => {
  const index = window.doccNavigatorIndex;
  if (!index) {
    return;
  }
  
  const INDEX_ROOT_KEY = "<root>";
  
  // This script is in the root of the output.
  const rootURL = new URL(".", document.currentScript.src);
  // Like the page's own links, the navigator's links are relative to the page, for example "../../", so that the output works from any location or hosting path.
  const pathToRoot = document.currentScript.getAttribute("src").replace(/[^/]*$/, "");
  
  // Returns the navigator index path, for example "/documentation/mykit/myclass", of a link to a page in this output.
  function indexPathForLink(href) {
    const path = new URL(href, location.href).pathname.slice(rootURL.pathname.length).replace(/[/]?(index[.]html)?$/, "");
    // Like DocC's file names, a path component that starts with a period starts with an apostrophe in the link.
    return "/" + decodeURIComponent(path).replace(/(^|[/])'(?=[.])/g, "$1").toLowerCase();
  }
  const currentPath = indexPathForLink(location.href);
  
  // Returns the link to a page's file, without encoding characters that are common in symbol names, like ":" or "(".
  function hrefForPath(path) {
    // Like DocC's file names, a path component that starts with a period starts with an apostrophe, so that it doesn't look like a hidden file.
    const components = path.split("/").filter(Boolean).map((component) => encodeURI(component.startsWith(".") ? `'${component}` : component).replace(/[#?]/g, encodeURIComponent));
    return pathToRoot + components.join("/") + "/index.html";
  }
  
  // Some browsers don't allow storage for pages that are loaded from disk. Then the navigator's state only lasts for the page.
  function withStorage(body) {
    try {
      return body();
    } catch {}
  }
  
  // MARK: Navigator data
  
  const languages = index.interfaceLanguages;
  const modules = languages.swift?.length ? languages.swift : Object.values(languages).find((modules) => modules.length);
  // In rare cases there are multiple top-level roots. Prefer the one whose path matches the current page.
  const rootPath = currentPath.split("/").slice(0, 3).join("/");
  const rootModule = modules?.find(({ path }) => path?.toLowerCase() === rootPath) ?? modules?.[0];
  if (!rootModule?.path || !rootModule.children?.length) {
    return;
  }
  const technologyPath = rootModule.path.toLowerCase();
  
  // All the items, in the order that the navigator displays them. An item's position in this list is its unique identifier.
  const children = [];
  function flattenNestedData(nodes, parent, depth, parentBetaStatus) {
    nodes.forEach(({ children: nodeChildren, ...node }, position) => {
      Object.assign(node, {
        uid: children.length,
        parent: parent?.uid ?? INDEX_ROOT_KEY,
        index: position,
        siblingsCount: nodes.length,
        depth,
        childUIDs: [],
        // If the parent or the entire technology is marked as "Beta", the child elements don't get marked as "Beta".
        beta: node.beta && !parentBetaStatus,
      });
      parent?.childUIDs.push(node.uid);
      children.push(node);
      flattenNestedData(nodeChildren ?? [], node, depth + 1, parentBetaStatus || node.beta);
    });
  }
  flattenNestedData(rootModule.children, null, 0, rootModule.beta);
  
  const getChildren = (uid) => uid === INDEX_ROOT_KEY
    ? children.filter(({ parent }) => parent === INDEX_ROOT_KEY)
    : children[uid].childUIDs.map((child) => children[child]);
  const getSiblings = (uid) => getChildren(children[uid].parent);
  // Returns the item and all its descendants, depth first.
  const getAllChildren = (uid) => [children[uid], ...children[uid].childUIDs.flatMap(getAllChildren)];
  // Returns the item and all its ancestors, starting from the top-level ancestor.
  const getParents = (uid) => children[uid] ? [...getParents(children[uid].parent), children[uid]] : [];
  
  // MARK: Icons
  
  function makeIcon(item) {
    const icon = document.createElement("div");
    icon.className = "navigator-icon";
    // The style sheet displays the icon for the item's type.
    icon.dataset.type = item.type;
    const imageURL = index.references?.[item.icon]?.variants?.[0]?.url;
    if (imageURL) {
      const image = document.createElement("img");
      image.src = pathToRoot + imageURL.slice(1);
      image.alt = "";
      icon.append(image);
    }
    return icon;
  }
  
  // MARK: Badges
  
  function makeBadge(variant) {
    const badge = document.createElement("span");
    badge.className = `badge badge-${variant}`;
    badge.textContent = variant === "deprecated" ? "Deprecated" : "Beta";
    return badge;
  }
  
  // MARK: State
  
  // The key includes the output's location, so that outputs on the same origin don't share their state.
  const storageKey = `docc.navigator.${rootURL.pathname}${technologyPath.slice(1)}`;
  const storedState = withStorage(() => JSON.parse(sessionStorage.getItem(storageKey)));
  // The stored items are positions in the navigator's items, so state from an output with different items doesn't apply.
  const restoredState = storedState?.itemCount === children.length ? storedState : {};
  
  // Returns the items for each path in a list of paths from the top of the hierarchy.
  function pathsToFlatChildren(paths) {
    const result = [];
    let candidates = children;
    for (const path of paths) {
      const node = candidates.find((child) => child.path?.toLowerCase() === path);
      if (!node) {
        break;
      }
      result.push(node);
      candidates = getChildren(node.uid);
    }
    return result;
  }
  
  function findActiveUID(activePath, previousActiveUID) {
    const matchesActivePage = (item) => item.path?.toLowerCase() === activePath.at(-1);
    // If the reader navigated from another item in the navigator, prefer that item or one that's close to it.
    if (children[previousActiveUID]) {
      const match = [
        children[previousActiveUID],
        ...getChildren(previousActiveUID),
        ...getSiblings(previousActiveUID),
        ...getParents(previousActiveUID),
      ].find(matchesActivePage);
      if (match) {
        return match.uid;
      }
    }
    // Otherwise, search across the active path for the active item.
    return pathsToFlatChildren(activePath).pop()?.uid ?? null;
  }
  
  // Follow the page's breadcrumbs, excluding the technology root, to find the current page in the location that it belongs.
  const breadcrumbs = [...document.querySelectorAll("#breadcrumbs a[href]")].map((link) => indexPathForLink(link.href));
  let activeUID = findActiveUID([...breadcrumbs.slice(1), currentPath], restoredState.activeUID);
  const activePathUIDs = new Set(getParents(activeUID).map(({ uid }) => uid));
  let allNodesToggled = false;
  
  // MARK: Rendering
  
  // Each item is a row, a `<summary>` inside a `<details>` element for items with children, and a `<div>` for other items.
  // The script only creates an item's children when the reader first opens it, so that large hierarchies stay fast.
  // The script keeps an item's elements on the item, once it creates them.
  const isOpen = (item) => !!item.details?.open;
  
  function makeRow(item) {
    const isGroupMarker = item.type === "groupMarker";
    const isParent = item.childUIDs.length > 0;
    const labelID = `navigator-${item.uid}-label`;
    
    const row = document.createElement(isParent ? "summary" : "div");
    row.className = "navigator-card-item";
    row.classList.toggle("is-group", isGroupMarker);
    row.classList.toggle("active", item.uid === activeUID);
    row.style.setProperty("--nesting-index", item.depth);
    row.dataset.uid = item.uid;
    // The reader moves the focus between the items' links with the arrow keys.
    row.tabIndex = -1;
    row.innerHTML = `<div class="head-wrapper"><div class="depth-spacer">${isParent ? `<span class="tree-toggle"><span class="chevron"></span></span>` : ""}</div><div class="title-container"><span hidden id="${labelID}"></span></div></div>`;
    if (!isGroupMarker) {
      row.querySelector(".depth-spacer").after(makeIcon(item));
    }
    
    const parentTitle = children[item.parent]?.title ?? rootModule.title;
    const titleContainer = row.querySelector(".title-container");
    titleContainer.firstChild.textContent = `${item.index + 1} of ${item.siblingsCount} symbols inside ${parentTitle}`
      + (isParent ? ` containing ${item.childUIDs.length === 1 ? "one symbol" : `${item.childUIDs.length} symbols`}` : "");
    
    const link = document.createElement(isGroupMarker ? "h3" : "a");
    link.className = "leaf-link";
    link.classList.toggle("bolded", activePathUIDs.has(item.uid));
    if (!isGroupMarker) {
      link.href = hrefForPath(item.path);
    }
    // The active item can be an ancestor of the current page, when the page isn't in the navigator.
    if (item.uid === activeUID && item.path?.toLowerCase() === currentPath) {
      link.setAttribute("aria-current", "page");
    }
    link.tabIndex = -1;
    link.setAttribute("aria-describedby", `${labelID} navigator-usage`);
    link.textContent = item.title;
    titleContainer.append(link);
    if (item.deprecated || item.beta) {
      titleContainer.append(makeBadge(item.deprecated ? "deprecated" : "beta"));
    }
    Object.assign(item, { row, link });
    
    if (!isParent) {
      return row;
    }
    item.details = document.createElement("details");
    item.details.append(row);
    return item.details;
  }
  
  const appendRows = (container, items) => container.append(...items.map(makeRow));
  
  // MARK: Toggling
  
  // Opens or closes an item, which creates the item's children the first time it opens.
  function setOpen(item, shouldOpen) {
    const { details } = item;
    if (!details) {
      return;
    }
    if (shouldOpen && details.children.length === 1) {
      appendRows(details, getChildren(item.uid));
    }
    // If the link that the reader can focus with the Tab key is inside the closed item, the item's own link takes its place.
    const tabbableLink = details.querySelector('.leaf-link[tabindex="0"]');
    if (!shouldOpen && tabbableLink && tabbableLink !== item.link) {
      tabbableLink.tabIndex = -1;
      item.link.tabIndex = 0;
    }
    details.open = shouldOpen;
  }
  
  // Opens or closes an item and all of its children, for example when the reader Option-clicks it.
  function setFullTreeOpen(item, shouldOpen) {
    for (const descendant of getAllChildren(item.uid)) {
      setOpen(descendant, shouldOpen);
    }
  }
  
  function toggleNode(item, fullTree = false) {
    const shouldOpen = !isOpen(item);
    // Closing an item also closes all of its children.
    if (fullTree || !shouldOpen) {
      setFullTreeOpen(item, shouldOpen);
    } else {
      setOpen(item, true);
    }
  }
  
  // Toggles an item and all of its siblings open or closed (Command-click).
  function toggleSiblings(item) {
    const shouldOpen = !isOpen(item);
    getSiblings(item.uid).forEach((sibling) => shouldOpen ? setOpen(sibling, true) : setFullTreeOpen(sibling, false));
  }
  
  // Toggles all items open or closed (Option-click on the technology title).
  function toggleAllNodes() {
    allNodesToggled = !allNodesToggled;
    getChildren(INDEX_ROOT_KEY).forEach((item) => setFullTreeOpen(item, allNodesToggled));
  }
  
  const technologyTitle = document.createElement("a");
  technologyTitle.className = "technology-title";
  technologyTitle.href = hrefForPath(technologyPath);
  technologyTitle.innerHTML = `<h2 class="card-link"></h2>`;
  technologyTitle.firstChild.textContent = rootModule.title;
  if (rootModule.beta) {
    technologyTitle.append(makeBadge("beta"));
  }
  if (technologyPath === currentPath) {
    technologyTitle.setAttribute("aria-current", "page");
  }
  
  const scroller = document.createElement("div");
  scroller.className = "scroller";
  const usageLabel = document.createElement("span");
  usageLabel.hidden = true;
  usageLabel.id = "navigator-usage";
  usageLabel.textContent = "To navigate the symbols, press Up Arrow, Down Arrow, Left Arrow or Right Arrow";
  
  // On narrow screens, the navigator has a title and a button that closes it.
  const head = document.createElement("div");
  head.className = "navigator-head";
  head.innerHTML = `<h2>Documentation</h2><button type="button" aria-label="Close Documentation Navigator"></button>`;
  const closeButton = head.lastChild;
  
  // The navigator and the page's main content go in a container below the page's header, and the button that shows and hides the navigator goes in the header.
  const navigator = document.createElement("nav");
  navigator.id = "navigator";
  navigator.setAttribute("aria-label", "Documentation Navigator");
  navigator.append(head, technologyTitle, scroller, usageLabel);
  const main = document.querySelector("body > main");
  const container = document.createElement("div");
  container.className = "full-width-container";
  main.before(container);
  container.append(navigator, main);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "navigator-toggle";
  toggle.setAttribute("aria-controls", navigator.id);
  toggle.setAttribute("aria-label", "Documentation Navigator");
  // The page's default header is right before the container, after any custom header. The button goes before its title, so that it isn't part of the heading.
  container.previousElementSibling.querySelector("h2").before(toggle);
  
  // Scrolls the active item into view, unless it's already visible.
  function scrollToActiveItem() {
    const element = children[activeUID]?.row;
    if (!element?.checkVisibility()) {
      return;
    }
    const scrollerBounds = scroller.getBoundingClientRect();
    const elementBounds = element.getBoundingClientRect();
    if (elementBounds.top < scrollerBounds.top || elementBounds.bottom > scrollerBounds.bottom) {
      scroller.scrollTop += elementBounds.top - scrollerBounds.top;
    }
  }
  
  // MARK: Interaction
  
  const itemForEvent = (event) => children[event.target.closest(".navigator-card-item")?.dataset.uid];
  // The links of the items inside open items, in the order that the navigator displays them.
  const visibleLinks = () => [...scroller.querySelectorAll(".leaf-link")].filter((link) => link.checkVisibility());
  
  // The link that has the focus is the only link that the reader can focus with the Tab key.
  // When an item's row gets the focus, for example when the reader clicks its toggle, its link gets the focus instead.
  scroller.addEventListener("focusin", (event) => {
    const item = itemForEvent(event);
    if (event.target !== item?.link) {
      item?.link.focus({ preventScroll: true });
      return;
    }
    scroller.querySelector('.leaf-link[tabindex="0"]')?.setAttribute("tabindex", "-1");
    item.link.tabIndex = 0;
    item.row.scrollIntoView({ block: "nearest" });
  });
  
  scroller.addEventListener("keydown", (event) => {
    const item = itemForEvent(event);
    if (!item) {
      return;
    }
    const hasModifiers = event.metaKey || event.ctrlKey || event.shiftKey;
    const isDown = event.key === "ArrowDown";
    switch (event.key) {
      case "ArrowUp":
      case "ArrowDown":
        if (event.altKey || !hasModifiers) {
          event.preventDefault();
          // Option-Up and Option-Down move the focus to the first and last item.
          const links = visibleLinks();
          links[event.altKey ? (isDown ? links.length - 1 : 0) : links.indexOf(item.link) + (isDown ? 1 : -1)]?.focus({ preventScroll: true });
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        // Close the item or, if it's already closed, move the focus to its parent.
        if (isOpen(item)) {
          toggleNode(item);
        } else {
          children[item.parent]?.link.focus({ preventScroll: true });
        }
        break;
      case "ArrowRight":
        event.preventDefault();
        if (event.altKey) {
          toggleNode(item, true);
        } else if (!hasModifiers && !isOpen(item)) {
          setOpen(item, true);
        }
        break;
    }
  });
  
  scroller.addEventListener("click", (event) => {
    const item = itemForEvent(event);
    if (!item) {
      return;
    }
    // Keyboards and assistive technologies activate a `<summary>` element with a click on the element itself.
    const isTreeToggle = event.target.closest(".tree-toggle") || (event.target.localName === "summary" && event.detail === 0);
    const hasOtherModifiers = event.ctrlKey || event.shiftKey;
    if (event.altKey || !event.target.closest(".leaf-link")) {
      // The script toggles the items itself, rather than letting the `<summary>` element toggle them, to support the modifier keys and to close their children.
      event.preventDefault();
    }
    if (event.altKey) {
      toggleNode(item, true);
    } else if (isTreeToggle && event.metaKey) {
      toggleSiblings(item);
    } else if (isTreeToggle && !hasOtherModifiers) {
      toggleNode(item);
    } else if (event.target.closest("a.leaf-link") && !event.metaKey && !hasOtherModifiers) {
      // Remember which item the reader clicked so that the next page displays it as the active item, even if the page is curated in more than one place.
      activeUID = item.uid;
    }
  });
  
  technologyTitle.addEventListener("click", (event) => {
    if (event.altKey) {
      event.preventDefault();
      toggleAllNodes();
    }
  });
  
  window.addEventListener("pagehide", () => withStorage(() => {
    const openNodes = children.filter(isOpen).map(({ uid }) => uid);
    sessionStorage.setItem(storageKey, JSON.stringify({ itemCount: children.length, openNodes, activeUID, scrollTop: scroller.scrollTop }));
  }));
  
  // MARK: Initial state
  
  appendRows(scroller, getChildren(INDEX_ROOT_KEY));
  // Keep the items that were open on the previous page open, and open the items leading to the active item.
  // The items are in the order that the navigator displays them, so each item's parent opens before the item.
  const restoredOpenUIDs = new Set(restoredState.openNodes);
  for (const item of children) {
    if (restoredOpenUIDs.has(item.uid) || activePathUIDs.has(item.uid)) {
      setOpen(item, true);
    }
  }
  // The active item is the one that the reader can focus with the Tab key.
  (children[activeUID]?.link ?? scroller.querySelector(".leaf-link")).tabIndex = 0;
  
  // MARK: Showing and hiding the navigator
  
  // On wide screens the navigator is visible unless the reader hides it. On narrow screens it's hidden unless the reader opens it.
  const wideScreen = matchMedia("(min-width: 1024px)");
  const collapsedStorageKey = "docc.navigator.collapsed";
  
  function updateToggle() {
    const isVisible = wideScreen.matches
      ? !document.body.classList.contains("navigator-collapsed")
      : document.body.classList.contains("navigator-open");
    toggle.setAttribute("aria-expanded", isVisible);
    if (isVisible) {
      scrollToActiveItem();
    }
  }
  
  document.body.classList.toggle("navigator-collapsed", withStorage(() => localStorage.getItem(collapsedStorageKey)) === "true");
  
  // On narrow screens the navigator is a panel over the page, so the rest of the page is inert while the panel is open,
  // the panel's close button has the focus when it opens, and the button that opened it has the focus when it closes.
  function setPanelOpen(isOpen) {
    const isChanging = document.body.classList.contains("navigator-open") !== isOpen;
    document.body.classList.toggle("navigator-open", isOpen);
    for (const element of [...document.body.children, main]) {
      element.inert = isOpen && element !== container;
    }
    updateToggle();
    if (isChanging) {
      (isOpen ? closeButton : toggle).focus();
    }
  }
  
  wideScreen.addEventListener("change", () => {
    // The navigator switches between the column and the panel without a transition.
    document.body.classList.add("navigator-no-transition");
    setPanelOpen(false);
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("navigator-no-transition")));
  });
  
  toggle.addEventListener("click", () => {
    if (wideScreen.matches) {
      const isCollapsed = document.body.classList.toggle("navigator-collapsed");
      withStorage(() => localStorage.setItem(collapsedStorageKey, isCollapsed));
      updateToggle();
    } else {
      setPanelOpen(!document.body.classList.contains("navigator-open"));
    }
  });
  
  closeButton.addEventListener("click", () => setPanelOpen(false));
  
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("navigator-open")) {
      setPanelOpen(false);
    }
  });
  
  // MARK: Resizing the navigator
  
  // The reader can drag the navigator's edge to resize it, and drag it past half of its minimum width to hide it.
  // The style sheet keeps the width between the minimum and maximum widths.
  const widthStorageKey = "docc.navigator.width";
  const setPreferredWidth = (width) => document.body.style.setProperty("--navigator-preferred-width", `${width}px`);
  const storedWidth = Number(withStorage(() => localStorage.getItem(widthStorageKey)));
  if (storedWidth > 0) {
    setPreferredWidth(storedWidth);
  }
  
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "resize-handle";
  navigator.append(resizeHandle);
  
  resizeHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    event.preventDefault();
    resizeHandle.setPointerCapture(event.pointerId);
    document.body.classList.add("navigator-resizing");
  });
  resizeHandle.addEventListener("pointermove", (event) => {
    if (!resizeHandle.hasPointerCapture(event.pointerId)) {
      return;
    }
    const width = event.clientX - navigator.getBoundingClientRect().left;
    if (width > Math.min(innerWidth, 1521) * 0.3 / 2) {
      setPreferredWidth(width);
    } else {
      // The navigator can only be resized when it's visible on a wide screen, where the button hides it.
      document.body.classList.remove("navigator-resizing");
      resizeHandle.releasePointerCapture(event.pointerId);
      toggle.click();
    }
  });
  resizeHandle.addEventListener("lostpointercapture", () => {
    // Dragging the edge past half of the minimum width already finished resizing, and hid the navigator.
    if (!document.body.classList.contains("navigator-resizing")) {
      return;
    }
    document.body.classList.remove("navigator-resizing");
    // Keep the width that the style sheet limited the dragged width to.
    if (navigator.offsetWidth) {
      setPreferredWidth(navigator.offsetWidth);
      withStorage(() => localStorage.setItem(widthStorageKey, navigator.offsetWidth));
    }
  });
  
  // Restore the previous page's scroll position so that the navigator doesn't jump, and then reveal the active item if it isn't visible.
  scroller.scrollTop = restoredState.scrollTop ?? 0;
  updateToggle();
})();
