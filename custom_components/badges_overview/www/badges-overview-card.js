/**
 * badges-overview-card.js  (v3)
 * ------------------------------------------------------------------
 * App / panneau Home Assistant pour gérer les badges de tous les
 * tableaux de bord depuis un seul endroit.
 *
 * - Utilisable comme PANNEAU dédié dans la barre latérale (recommandé)
 *   ou comme simple carte Lovelace.
 * - Deux modes d'affichage, inversables :
 *     - "Par tableau de bord" : chaque dashboard > vue > ses badges.
 *     - "Par badge" : chaque badge unique, avec la liste des
 *       tableaux de bord / vues où il apparaît.
 * - Création globale d'un badge, affectable en un clic à plusieurs
 *   vues de plusieurs tableaux de bord à la fois.
 * - Ajout/suppression ponctuels toujours possibles depuis la vue
 *   "par tableau de bord".
 *   -> Édition uniquement pour les tableaux de bord en mode UI/storage.
 *      Les tableaux de bord en mode YAML restent en lecture seule.
 * ------------------------------------------------------------------
 */

class BadgesOverviewApp extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._dashboards = null;
    this._loading = false;
    this._error = null;
    this._search = "";
    this._badgeEls = new Map();
    this._pending = new Set();
    this._saving = new Set();
    this._saveErrors = new Map();
    this._forceEdit = new Set();
    this._addingFor = null;
    this._groupBy = "dashboard"; // "dashboard" | "badge"
    this._creating = false;
    this._createEntity = null;
    this._createName = "";
    this._createIcon = "";
    this._createShowName = true;
    this._createTargets = new Set();
    this._editing = null; // { dashIndex, viewIndex, badgeIndex }
    this._editingGroup = null; // { occurrences, count }
    this._editEntity = "";
    this._editName = "";
    this._editIcon = "";
    this._editShowName = true;
  }

  // ---- Entrée "carte" classique -------------------------------------
  setConfig(config) {
    this._config = config || {};
  }
  getCardSize() {
    return 8;
  }

  // ---- Entrée "panneau" (app dédiée dans la barre latérale) ---------
  set panel(panel) {
    this._panel = panel;
  }
  set narrow(narrow) {
    this._narrow = narrow;
  }
  set route(route) {
    this._route = route;
  }

  connectedCallback() {
    if (!this.shadowRoot.firstChild) {
      this._renderShell("Initialisation… (en attente de la connexion Home Assistant)");
    }
    if (this._hass && !this._dashboards && !this._loading) {
      this._loadDashboards();
    }
  }

  set hass(hass) {
    this._hass = hass;
    try {
      if (!this._dashboards && !this._loading) {
        this._loadDashboards();
        return;
      }
      this._badgeEls.forEach((el) => {
        el.hass = hass;
      });
    } catch (e) {
      console.error("[badges-overview] erreur dans le setter hass:", e);
      this._renderShell(`Erreur inattendue : ${e.message || e}. Voir la console (F12) pour le détail.`);
    }
  }
  get hass() {
    return this._hass;
  }

  // ---------------------------------------------------------------
  // Chargement des données
  // ---------------------------------------------------------------
  async _loadDashboards() {
    if (!this._hass) return;
    this._loading = true;
    this._error = null;
    this._renderShell("Chargement des tableaux de bord…");
    console.log("[badges-overview] chargement des tableaux de bord…");

    try {
      let extra = [];
      try {
        extra = await this._hass.callWS({ type: "lovelace/dashboards/list" });
      } catch (e) {
        extra = [];
      }

      const defaultAlreadyListed = extra.some((d) => !d.url_path);
      const dashboardsMeta = defaultAlreadyListed
        ? extra
        : [{ url_path: null, title: "Tableau de bord par défaut", mode: undefined }, ...extra];

      const seen = new Set();
      const dedupedMeta = dashboardsMeta.filter((d) => {
        const key = d.url_path || "__default__";
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const results = [];
      for (const meta of dedupedMeta) {
        try {
          const config = await this._hass.callWS({
            type: "lovelace/config",
            url_path: meta.url_path || undefined,
          });
          results.push({ meta, config, mode: this._detectMode(meta) });
        } catch (e) {
          results.push({ meta, config: null, error: e.message || String(e), mode: "unknown" });
        }
      }

      // Filet de sécurité final : deux entrées peuvent pointer vers le même
      // tableau de bord sous des noms différents (ex. "Tableau de bord par
      // défaut" et "Aperçu"), même si leur url_path diffère. On déduplique
      // donc aussi par CONTENU réel de la configuration.
      const seenConfigSignatures = new Set();
      const uniqueResults = [];
      for (const r of results) {
        if (r.config) {
          const signature = JSON.stringify(r.config);
          if (seenConfigSignatures.has(signature)) {
            console.log(
              "[badges-overview] doublon ignoré (même contenu) :",
              r.meta.title || r.meta.url_path
            );
            continue;
          }
          seenConfigSignatures.add(signature);
        }
        uniqueResults.push(r);
      }

      this._dashboards = uniqueResults;
      console.log("[badges-overview]", uniqueResults.length, "tableau(x) de bord chargé(s)", uniqueResults);
    } catch (e) {
      console.error("[badges-overview] erreur de chargement:", e);
      this._error = e.message || String(e);
    } finally {
      this._loading = false;
      try {
        this._buildStructure();
      } catch (e2) {
        console.error("[badges-overview] erreur de rendu:", e2);
        this._renderShell(`Erreur d'affichage : ${e2.message || e2}. Voir la console (F12) pour le détail.`);
      }
    }
  }

  _detectMode(meta) {
    const key = meta.url_path || "lovelace";
    const panelInfo = this._hass && this._hass.panels && this._hass.panels[key];
    if (panelInfo && panelInfo.config && panelInfo.config.mode) {
      return panelInfo.config.mode;
    }
    if (meta.mode) return meta.mode;
    return "unknown";
  }

  _normalizeBadge(b) {
    if (typeof b === "string") {
      return { type: "entity", entity: b };
    }
    return b;
  }

  _badgeKey(badgeConfig) {
    // Clé d'identité utilisée pour regrouper les badges identiques en mode
    // "par badge". Les badges d'entité sont regroupés par entity_id ; les
    // autres types (rares) sont regroupés par configuration exacte.
    if (badgeConfig && badgeConfig.entity) return `entity:${badgeConfig.entity}`;
    return `config:${JSON.stringify(badgeConfig)}`;
  }

  // ---------------------------------------------------------------
  // Édition (ajout / suppression de badges)
  // ---------------------------------------------------------------
  _isEditable(dashIndex) {
    const dash = this._dashboards[dashIndex];
    if (!dash || dash.error || !dash.config) return false;
    if (dash.mode === "storage") return true;
    if (dash.mode === "unknown" && this._forceEdit.has(dashIndex)) return true;
    return false;
  }

  _addBadge(dashIndex, viewIndex, entityId) {
    if (!entityId) return;
    const view = this._dashboards[dashIndex].config.views[viewIndex];
    if (!view.badges) view.badges = [];
    view.badges.push({ type: "entity", entity: entityId });
    this._pending.add(dashIndex);
    this._addingFor = null;
    this._buildStructure();
  }

  _removeBadge(dashIndex, viewIndex, badgeIndex) {
    const view = this._dashboards[dashIndex].config.views[viewIndex];
    view.badges.splice(badgeIndex, 1);
    this._pending.add(dashIndex);
    this._buildStructure();
  }

  // Barre visible quel que soit le mode d'affichage ("par tableau de
  // bord" ou "par badge") tant qu'il reste des modifications à enregistrer.
  _buildPendingBar() {
    const bar = document.createElement("div");
    bar.className = "pending-bar";

    const label = document.createElement("span");
    label.className = "pending-label";
    const n = this._pending.size;
    label.textContent = `${n} tableau${n > 1 ? "x" : ""} de bord avec des modifications non enregistrées :`;
    bar.appendChild(label);

    Array.from(this._pending).forEach((dashIndex) => {
      const dash = this._dashboards[dashIndex];
      if (!dash) return;
      const btn = document.createElement("button");
      btn.className = "btn primary small";
      const title = dash.meta.title || dash.meta.url_path || "Sans titre";
      btn.textContent = this._saving.has(dashIndex) ? `Enregistrement… (${title})` : `💾 ${title}`;
      btn.disabled = this._saving.has(dashIndex);
      btn.addEventListener("click", () => this._saveDashboard(dashIndex));
      bar.appendChild(btn);
    });

    if (this._pending.size > 1) {
      const saveAllBtn = document.createElement("button");
      saveAllBtn.className = "btn primary";
      saveAllBtn.textContent = "💾 Tout enregistrer";
      saveAllBtn.disabled = this._saving.size > 0;
      saveAllBtn.addEventListener("click", () => this._saveAllPending());
      bar.appendChild(saveAllBtn);
    }

    return bar;
  }

  async _saveAllPending() {
    const indices = Array.from(this._pending);
    for (const idx of indices) {
      await this._saveDashboard(idx);
    }
  }

  async _saveDashboard(dashIndex) {
    const dash = this._dashboards[dashIndex];
    this._saving.add(dashIndex);
    this._saveErrors.delete(dashIndex);
    this._buildStructure();
    try {
      await this._hass.callWS({
        type: "lovelace/config/save",
        url_path: dash.meta.url_path || undefined,
        config: dash.config,
      });
      this._pending.delete(dashIndex);
    } catch (e) {
      this._saveErrors.set(dashIndex, e.message || String(e));
    } finally {
      this._saving.delete(dashIndex);
      this._buildStructure();
    }
  }

  // ---- Création globale, multi-affectation ---------------------
  _confirmCreateBadge() {
    const entityId = this._createEntity;
    if (!entityId) {
      alert("Choisis une entité avant de créer le badge.");
      return;
    }
    if (!this._createTargets.size) {
      alert("Sélectionne au moins une vue à laquelle affecter ce badge.");
      return;
    }
    const badge = { type: "entity", entity: entityId };
    if (this._createName && this._createName.trim()) {
      badge.name = this._createName.trim();
    }
    if (this._createIcon && this._createIcon.trim()) {
      badge.icon = this._createIcon.trim();
    }
    badge.show_name = !!this._createShowName;
    this._createTargets.forEach((key) => {
      const [dashIndexStr, viewIndexStr] = key.split("::");
      const dashIndex = parseInt(dashIndexStr, 10);
      const viewIndex = parseInt(viewIndexStr, 10);
      const dash = this._dashboards[dashIndex];
      if (!dash || !dash.config || !dash.config.views) return;
      const view = dash.config.views[viewIndex];
      if (!view) return;
      if (!view.badges) view.badges = [];
      const already = view.badges.some(
        (b) => (typeof b === "string" ? b : b.entity) === entityId
      );
      if (!already) {
        view.badges.push({ ...badge });
        this._pending.add(dashIndex);
      }
    });
    this._creating = false;
    this._createEntity = null;
    this._createName = "";
    this._createIcon = "";
    this._createShowName = true;
    this._createTargets = new Set();
    this._buildStructure();
  }

  // ---- Édition d'un badge existant --------------------------------
  _startEdit(dashIndex, viewIndex, badgeIndex) {
    const view = this._dashboards[dashIndex].config.views[viewIndex];
    const current = this._normalizeBadge(view.badges[badgeIndex]) || {};
    this._editing = { dashIndex, viewIndex, badgeIndex };
    this._editEntity = current.entity || "";
    this._editName = current.name || "";
    this._editIcon = current.icon || "";
    this._editShowName = current.show_name !== undefined ? !!current.show_name : Boolean(current.name);
    this._buildStructure();
  }

  _confirmEditBadge() {
    if (!this._editEntity) {
      alert("Choisis une entité.");
      return;
    }
    const { dashIndex, viewIndex, badgeIndex } = this._editing;
    const view = this._dashboards[dashIndex].config.views[viewIndex];
    const current = this._normalizeBadge(view.badges[badgeIndex]) || {};
    const newConfig = { ...current, type: current.type || "entity", entity: this._editEntity };
    if (this._editName && this._editName.trim()) {
      newConfig.name = this._editName.trim();
    } else {
      delete newConfig.name;
    }
    if (this._editIcon && this._editIcon.trim()) {
      newConfig.icon = this._editIcon.trim();
    } else {
      delete newConfig.icon;
    }
    newConfig.show_name = !!this._editShowName;
    view.badges[badgeIndex] = newConfig;
    this._pending.add(dashIndex);
    this._editing = null;
    this._buildStructure();
  }

  _cancelEdit() {
    this._editing = null;
    this._buildStructure();
  }

  // ---- Édition groupée (mode "par badge" : toutes les occurrences) --
  _startEditGroup(occurrences, currentConfig) {
    this._editingGroup = { occurrences, count: occurrences.length };
    this._editEntity = currentConfig.entity || "";
    this._editName = currentConfig.name || "";
    this._editIcon = currentConfig.icon || "";
    this._editShowName =
      currentConfig.show_name !== undefined ? !!currentConfig.show_name : Boolean(currentConfig.name);
    this._buildStructure();
  }

  _confirmEditGroupBadge() {
    if (!this._editEntity) {
      alert("Choisis une entité.");
      return;
    }
    const { occurrences } = this._editingGroup;
    occurrences.forEach((occ) => {
      if (!occ.editable) return; // on ne touche pas aux vues en lecture seule
      const dash = this._dashboards[occ.dashIndex];
      if (!dash || !dash.config) return;
      const view = dash.config.views[occ.viewIndex];
      if (!view) return;
      const current = this._normalizeBadge(view.badges[occ.badgeIndex]) || {};
      const newConfig = { ...current, type: current.type || "entity", entity: this._editEntity };
      if (this._editName && this._editName.trim()) {
        newConfig.name = this._editName.trim();
      } else {
        delete newConfig.name;
      }
      if (this._editIcon && this._editIcon.trim()) {
        newConfig.icon = this._editIcon.trim();
      } else {
        delete newConfig.icon;
      }
      newConfig.show_name = !!this._editShowName;
      view.badges[occ.badgeIndex] = newConfig;
      this._pending.add(occ.dashIndex);
    });
    this._editingGroup = null;
    this._buildStructure();
  }

  _cancelEditGroup() {
    this._editingGroup = null;
    this._buildStructure();
  }

  // ---------------------------------------------------------------
  // Rendu des badges (réutilisation du composant interne HA)
  // ---------------------------------------------------------------
  _renderBadgeElement(id, badgeConfig) {
    let el = this._badgeEls.get(id);
    if (el) return el;

    if (customElements.get("hui-badge")) {
      try {
        el = document.createElement("hui-badge");
        el.hass = this._hass;
        if (typeof el.setConfig === "function") {
          el.setConfig(badgeConfig);
        } else {
          el.config = badgeConfig;
        }
        this._badgeEls.set(id, el);
        return el;
      } catch (e) {
        // repli ci-dessous
      }
    }

    el = this._fallbackBadge(badgeConfig);
    this._badgeEls.set(id, el);
    return el;
  }

  _fallbackBadge(badgeConfig) {
    const wrapper = document.createElement("div");
    wrapper.className = "fallback-badge";
    const entityId = badgeConfig.entity;
    const state = this._hass && entityId ? this._hass.states[entityId] : null;
    const icon =
      badgeConfig.icon ||
      (state && state.attributes && state.attributes.icon) ||
      "mdi:help-circle-outline";
    const name =
      badgeConfig.name ||
      (state && state.attributes && state.attributes.friendly_name) ||
      entityId ||
      "?";
    const stateText = state ? state.state : "indisponible";

    const iconEl = document.createElement("ha-icon");
    iconEl.setAttribute("icon", icon);
    wrapper.appendChild(iconEl);

    const textEl = document.createElement("span");
    textEl.className = "fallback-badge-text";
    textEl.textContent = `${name}: ${stateText}`;
    wrapper.appendChild(textEl);

    if (!state && entityId) {
      wrapper.title = `Entité introuvable : ${entityId}`;
      wrapper.classList.add("missing");
    }
    return wrapper;
  }

  _navigateTo(dashboardUrlPath, viewPath) {
    const base = dashboardUrlPath ? dashboardUrlPath : "lovelace";
    const url = `/${base}/${viewPath}`;
    window.history.pushState(null, "", url);
    window.dispatchEvent(new CustomEvent("location-changed", { bubbles: true }));
  }

  // ---------------------------------------------------------------
  // Construction du DOM
  // ---------------------------------------------------------------
  _buildStructure() {
    const root = this.shadowRoot;
    root.innerHTML = "";
    this._badgeEls.clear();

    const style = document.createElement("style");
    style.textContent = this._css();
    root.appendChild(style);

    const page = document.createElement("div");
    page.className = "page";

    const header = document.createElement("div");
    header.className = "app-header";
    const h1 = document.createElement("h1");
    h1.textContent = "Badges — vue d'ensemble";
    header.appendChild(h1);
    page.appendChild(header);

    const content = document.createElement("div");
    content.className = "content";

    // Barre d'outils
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Filtrer par nom / entité…";
    search.value = this._search;
    search.addEventListener("input", (e) => {
      this._search = e.target.value.toLowerCase();
      this._applyFilter();
    });
    toolbar.appendChild(search);

    const groupToggle = document.createElement("div");
    groupToggle.className = "segmented";
    const byDashBtn = document.createElement("button");
    byDashBtn.className = "segment" + (this._groupBy === "dashboard" ? " active" : "");
    byDashBtn.textContent = "Par tableau de bord";
    byDashBtn.addEventListener("click", () => {
      if (this._groupBy !== "dashboard") {
        this._groupBy = "dashboard";
        this._buildStructure();
      }
    });
    const byBadgeBtn = document.createElement("button");
    byBadgeBtn.className = "segment" + (this._groupBy === "badge" ? " active" : "");
    byBadgeBtn.textContent = "Par badge";
    byBadgeBtn.addEventListener("click", () => {
      if (this._groupBy !== "badge") {
        this._groupBy = "badge";
        this._buildStructure();
      }
    });
    groupToggle.appendChild(byDashBtn);
    groupToggle.appendChild(byBadgeBtn);
    toolbar.appendChild(groupToggle);

    const createBtn = document.createElement("button");
    createBtn.className = "btn primary";
    createBtn.textContent = "+ Créer un badge";
    createBtn.addEventListener("click", () => {
      this._creating = true;
      this._buildStructure();
    });
    toolbar.appendChild(createBtn);

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "btn";
    refreshBtn.textContent = "⟳ Actualiser";
    refreshBtn.addEventListener("click", () => {
      this._dashboards = null;
      this._pending.clear();
      this._loadDashboards();
    });
    toolbar.appendChild(refreshBtn);

    content.appendChild(toolbar);

    if (this._error) {
      const err = document.createElement("div");
      err.className = "error";
      err.textContent = `Erreur : ${this._error}`;
      content.appendChild(err);
    }

    const summary = document.createElement("div");
    summary.className = "summary";
    content.appendChild(summary);

    if (this._pending.size > 0) {
      content.appendChild(this._buildPendingBar());
    }

    if (this._groupBy === "dashboard") {
      this._renderByDashboard(content, summary);
    } else {
      this._renderByBadge(content, summary);
    }

    page.appendChild(content);
    root.appendChild(page);

    if (this._creating) {
      page.appendChild(this._buildCreatePanel());
    }
    if (this._editing) {
      page.appendChild(this._buildEditPanel());
    }
    if (this._editingGroup) {
      page.appendChild(this._buildEditGroupPanel());
    }

    this._applyFilter();
  }

  // ---- Mode "par tableau de bord" --------------------------------
  _renderByDashboard(content, summary) {
    let totalBadges = 0;
    const dashboards = this._dashboards || [];

    dashboards.forEach((dash, dashIndex) => {
      const editable = this._isEditable(dashIndex);
      const dashSection = document.createElement("div");
      dashSection.className = "dashboard-section";

      const dashHeader = document.createElement("div");
      dashHeader.className = "dashboard-header";

      const dashTitle = document.createElement("h2");
      dashTitle.textContent = dash.meta.title || dash.meta.url_path || "Sans titre";
      dashHeader.appendChild(dashTitle);

      const modeTag = document.createElement("span");
      modeTag.className = `mode-tag mode-${dash.mode}`;
      modeTag.textContent =
        dash.mode === "storage"
          ? "Mode UI (éditable)"
          : dash.mode === "yaml"
          ? "Mode YAML (lecture seule)"
          : "Mode indéterminé";
      dashHeader.appendChild(modeTag);

      if (dash.mode === "unknown" && !dash.error) {
        const forceBtn = document.createElement("button");
        forceBtn.className = "btn small";
        forceBtn.textContent = this._forceEdit.has(dashIndex)
          ? "Désactiver l'édition forcée"
          : "Forcer l'édition (à vos risques)";
        forceBtn.addEventListener("click", () => {
          if (this._forceEdit.has(dashIndex)) this._forceEdit.delete(dashIndex);
          else this._forceEdit.add(dashIndex);
          this._buildStructure();
        });
        dashHeader.appendChild(forceBtn);
      }

      if (this._pending.has(dashIndex)) {
        const saveBtn = document.createElement("button");
        saveBtn.className = "btn primary";
        saveBtn.textContent = this._saving.has(dashIndex)
          ? "Enregistrement…"
          : "💾 Enregistrer les modifications";
        saveBtn.disabled = this._saving.has(dashIndex);
        saveBtn.addEventListener("click", () => this._saveDashboard(dashIndex));
        dashHeader.appendChild(saveBtn);
      }

      dashSection.appendChild(dashHeader);

      if (this._saveErrors.has(dashIndex)) {
        const err = document.createElement("div");
        err.className = "error";
        err.textContent = `Échec de l'enregistrement : ${this._saveErrors.get(dashIndex)}`;
        dashSection.appendChild(err);
      }

      if (dash.error) {
        const err = document.createElement("div");
        err.className = "error";
        err.textContent = `Impossible de charger ce tableau de bord : ${dash.error}`;
        dashSection.appendChild(err);
      }

      const views = (dash.config && dash.config.views) || [];
      if (!views.length && !dash.error) {
        const empty = document.createElement("div");
        empty.className = "muted";
        empty.textContent = "Aucune vue.";
        dashSection.appendChild(empty);
      }

      views.forEach((view, viewIndex) => {
        const badges = (view.badges || []).map((b) => this._normalizeBadge(b));

        const viewSection = document.createElement("div");
        viewSection.className = "view-section filterable";
        viewSection.dataset.search = (
          (view.title || view.path || "") +
          " " +
          badges.map((b) => (b.entity || b.name || "")).join(" ")
        ).toLowerCase();

        const viewHeader = document.createElement("div");
        viewHeader.className = "view-header";

        const viewTitle = document.createElement("span");
        viewTitle.className = "view-title";
        viewTitle.textContent = view.title || view.path || `Vue ${viewIndex + 1}`;
        viewHeader.appendChild(viewTitle);

        const countSpan = document.createElement("span");
        countSpan.className = "badge-count";
        countSpan.textContent = `${badges.length} badge${badges.length > 1 ? "s" : ""}`;
        viewHeader.appendChild(countSpan);

        const openBtn = document.createElement("button");
        openBtn.className = "btn small";
        openBtn.textContent = "Ouvrir la vue →";
        openBtn.addEventListener("click", () =>
          this._navigateTo(dash.meta.url_path, view.path || String(viewIndex))
        );
        viewHeader.appendChild(openBtn);

        viewSection.appendChild(viewHeader);

        const row = document.createElement("div");
        row.className = "badge-row";

        if (!badges.length) {
          const none = document.createElement("span");
          none.className = "muted";
          none.textContent = "Aucun badge sur cette vue.";
          row.appendChild(none);
        }

        badges.forEach((badgeConfig, i) => {
          const id = `${dash.meta.url_path || "default"}::${view.path || viewIndex}::${i}`;
          const badgeWrap = document.createElement("div");
          badgeWrap.className = "badge-wrap";
          const el = this._renderBadgeElement(id, badgeConfig);
          badgeWrap.appendChild(el);

          if (editable) {
            const editBtn = document.createElement("button");
            editBtn.className = "edit-badge-btn";
            editBtn.title = "Modifier ce badge";
            editBtn.textContent = "✎";
            editBtn.addEventListener("click", () =>
              this._startEdit(dashIndex, viewIndex, i)
            );
            badgeWrap.appendChild(editBtn);

            const removeBtn = document.createElement("button");
            removeBtn.className = "remove-badge-btn";
            removeBtn.title = "Supprimer ce badge";
            removeBtn.textContent = "×";
            removeBtn.addEventListener("click", () =>
              this._removeBadge(dashIndex, viewIndex, i)
            );
            badgeWrap.appendChild(removeBtn);
          }

          row.appendChild(badgeWrap);
          totalBadges += 1;
        });

        if (editable) {
          const addKey = `${dashIndex}::${viewIndex}`;
          if (this._addingFor === addKey) {
            row.appendChild(this._buildEntityPicker(dashIndex, viewIndex));
          } else {
            const addBtn = document.createElement("button");
            addBtn.className = "add-badge-btn";
            addBtn.textContent = "+ Ajouter";
            addBtn.addEventListener("click", () => {
              this._addingFor = addKey;
              this._buildStructure();
            });
            row.appendChild(addBtn);
          }
        }

        viewSection.appendChild(row);
        dashSection.appendChild(viewSection);
      });

      content.appendChild(dashSection);
    });

    summary.textContent = `${totalBadges} badge${totalBadges > 1 ? "s" : ""} au total sur ${dashboards.length} tableau(x) de bord.`;
  }

  // ---- Mode "par badge" ------------------------------------------
  _renderByBadge(content, summary) {
    const dashboards = this._dashboards || [];
    const groups = new Map(); // key -> { config, occurrences: [...] }

    dashboards.forEach((dash, dashIndex) => {
      const views = (dash.config && dash.config.views) || [];
      views.forEach((view, viewIndex) => {
        const badges = (view.badges || []).map((b) => this._normalizeBadge(b));
        badges.forEach((badgeConfig, badgeIndex) => {
          const key = this._badgeKey(badgeConfig);
          if (!groups.has(key)) {
            groups.set(key, { config: badgeConfig, occurrences: [] });
          }
          groups.get(key).occurrences.push({
            dashIndex,
            viewIndex,
            badgeIndex,
            dashTitle: dash.meta.title || dash.meta.url_path || "Sans titre",
            dashUrlPath: dash.meta.url_path,
            viewTitle: view.title || view.path || `Vue ${viewIndex + 1}`,
            viewPath: view.path || String(viewIndex),
            editable: this._isEditable(dashIndex),
          });
        });
      });
    });

    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      const nameA = (groups.get(a).config.entity || a).toLowerCase();
      const nameB = (groups.get(b).config.entity || b).toLowerCase();
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    });

    if (!sortedKeys.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "Aucun badge trouvé.";
      content.appendChild(empty);
      summary.textContent = "0 badge.";
      return;
    }

    const list = document.createElement("div");
    list.className = "badge-group-list";

    let totalOccurrences = 0;

    sortedKeys.forEach((key) => {
      const group = groups.get(key);
      totalOccurrences += group.occurrences.length;

      const groupEl = document.createElement("div");
      groupEl.className = "badge-group filterable";
      const entityName =
        group.config.entity ||
        group.config.name ||
        (this._hass && group.config.entity && this._hass.states[group.config.entity]
          ? this._hass.states[group.config.entity].attributes.friendly_name
          : "") ||
        "?";
      groupEl.dataset.search = (
        entityName +
        " " +
        group.occurrences.map((o) => o.dashTitle + " " + o.viewTitle).join(" ")
      ).toLowerCase();

      const groupHeader = document.createElement("div");
      groupHeader.className = "badge-group-header";

      const badgeWrap = document.createElement("div");
      badgeWrap.className = "badge-wrap";
      const el = this._renderBadgeElement(`group::${key}`, group.config);
      badgeWrap.appendChild(el);

      const anyEditableOcc = group.occurrences.some((o) => o.editable);
      if (anyEditableOcc) {
        const editBtn = document.createElement("button");
        editBtn.className = "edit-badge-btn";
        editBtn.title = "Modifier ce badge sur toutes les vues où il apparaît";
        editBtn.textContent = "✎";
        editBtn.addEventListener("click", () =>
          this._startEditGroup(group.occurrences, group.config)
        );
        badgeWrap.appendChild(editBtn);
      }

      groupHeader.appendChild(badgeWrap);

      const countTag = document.createElement("span");
      const nbDashboards = new Set(group.occurrences.map((o) => o.dashIndex)).size;
      countTag.className = "badge-count";
      countTag.textContent = `présent sur ${group.occurrences.length} vue${
        group.occurrences.length > 1 ? "s" : ""
      } (${nbDashboards} tableau${nbDashboards > 1 ? "x" : ""} de bord)`;
      groupHeader.appendChild(countTag);

      groupEl.appendChild(groupHeader);

      const occList = document.createElement("div");
      occList.className = "occurrence-list";
      group.occurrences.forEach((occ) => {
        const chip = document.createElement("div");
        chip.className = "occurrence-chip";

        const label = document.createElement("span");
        label.className = "occurrence-label";
        label.textContent = `${occ.dashTitle} › ${occ.viewTitle}`;
        label.title = "Cliquer pour ouvrir cette vue";
        label.addEventListener("click", () => this._navigateTo(occ.dashUrlPath, occ.viewPath));
        chip.appendChild(label);

        if (occ.editable) {
          const removeBtn = document.createElement("button");
          removeBtn.className = "remove-occurrence-btn";
          removeBtn.title = "Retirer le badge de cette vue";
          removeBtn.textContent = "×";
          removeBtn.addEventListener("click", () =>
            this._removeBadge(occ.dashIndex, occ.viewIndex, occ.badgeIndex)
          );
          chip.appendChild(removeBtn);
        }

        occList.appendChild(chip);
      });
      groupEl.appendChild(occList);

      list.appendChild(groupEl);
    });

    content.appendChild(list);
    summary.textContent = `${sortedKeys.length} badge${
      sortedKeys.length > 1 ? "s" : ""
    } unique(s), ${totalOccurrences} occurrence${totalOccurrences > 1 ? "s" : ""} au total sur ${dashboards.length} tableau(x) de bord.`;
  }

  // ---- Panneau de création globale --------------------------------
  _buildCreatePanel() {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        this._creating = false;
        this._buildStructure();
      }
    });

    const modal = document.createElement("div");
    modal.className = "modal";

    const title = document.createElement("h3");
    title.textContent = "Créer un badge";
    modal.appendChild(title);

    const pickerLabel = document.createElement("div");
    pickerLabel.className = "field-label";
    pickerLabel.textContent = "Entité :";
    modal.appendChild(pickerLabel);

    if (customElements.get("ha-entity-picker")) {
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      if (this._createEntity) picker.value = this._createEntity;
      picker.addEventListener("value-changed", (ev) => {
        this._createEntity = ev.detail && ev.detail.value;
      });
      modal.appendChild(picker);
      setTimeout(() => picker.focus && picker.focus(), 0);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "ex: light.salon";
      input.value = this._createEntity || "";
      input.addEventListener("input", (e) => {
        this._createEntity = e.target.value.trim();
      });
      modal.appendChild(input);
    }

    this._buildNameIconFields(modal, {
      getName: () => this._createName,
      setName: (v) => {
        this._createName = v;
      },
      getIcon: () => this._createIcon,
      setIcon: (v) => {
        this._createIcon = v;
      },
      getShowName: () => this._createShowName,
      setShowName: (v) => {
        this._createShowName = v;
      },
    });

    const targetsLabel = document.createElement("div");
    targetsLabel.className = "field-label";
    targetsLabel.textContent = "Affecter aux vues :";
    modal.appendChild(targetsLabel);

    const targetsList = document.createElement("div");
    targetsList.className = "targets-list";

    let anyEditableView = false;

    (this._dashboards || []).forEach((dash, dashIndex) => {
      if (!this._isEditable(dashIndex)) return;
      const views = (dash.config && dash.config.views) || [];
      if (!views.length) return;

      const dashGroup = document.createElement("div");
      dashGroup.className = "target-dash-group";

      const dashHeaderRow = document.createElement("div");
      dashHeaderRow.className = "target-dash-header";

      const selectAll = document.createElement("input");
      selectAll.type = "checkbox";
      const allKeysForDash = views.map((v, vi) => `${dashIndex}::${vi}`);
      selectAll.checked = allKeysForDash.every((k) => this._createTargets.has(k));
      selectAll.addEventListener("change", () => {
        allKeysForDash.forEach((k) => {
          if (selectAll.checked) this._createTargets.add(k);
          else this._createTargets.delete(k);
        });
        this._buildStructure();
      });
      dashHeaderRow.appendChild(selectAll);

      const dashLabel = document.createElement("span");
      dashLabel.className = "target-dash-label";
      dashLabel.textContent = dash.meta.title || dash.meta.url_path || "Sans titre";
      dashHeaderRow.appendChild(dashLabel);

      dashGroup.appendChild(dashHeaderRow);

      views.forEach((view, viewIndex) => {
        anyEditableView = true;
        const key = `${dashIndex}::${viewIndex}`;
        const row = document.createElement("label");
        row.className = "target-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = this._createTargets.has(key);
        cb.addEventListener("change", () => {
          if (cb.checked) this._createTargets.add(key);
          else this._createTargets.delete(key);
        });
        row.appendChild(cb);
        const span = document.createElement("span");
        span.textContent = view.title || view.path || `Vue ${viewIndex + 1}`;
        row.appendChild(span);
        dashGroup.appendChild(row);
      });

      targetsList.appendChild(dashGroup);
    });

    if (!anyEditableView) {
      const none = document.createElement("div");
      none.className = "muted";
      none.textContent =
        "Aucune vue éditable trouvée (tous tes tableaux de bord sont peut-être en mode YAML, ou aucune donnée n'est chargée).";
      targetsList.appendChild(none);
    }

    modal.appendChild(targetsList);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Annuler";
    cancelBtn.addEventListener("click", () => {
      this._creating = false;
      this._createEntity = null;
      this._createName = "";
      this._createTargets = new Set();
      this._buildStructure();
    });
    actions.appendChild(cancelBtn);

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn primary";
    confirmBtn.textContent = "Créer et affecter";
    confirmBtn.addEventListener("click", () => this._confirmCreateBadge());
    actions.appendChild(confirmBtn);

    modal.appendChild(actions);
    overlay.appendChild(modal);
    return overlay;
  }

  _buildEditPanel() {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this._cancelEdit();
    });

    const modal = document.createElement("div");
    modal.className = "modal";

    const title = document.createElement("h3");
    title.textContent = "Modifier le badge";
    modal.appendChild(title);

    const pickerLabel = document.createElement("div");
    pickerLabel.className = "field-label";
    pickerLabel.textContent = "Entité :";
    modal.appendChild(pickerLabel);

    if (customElements.get("ha-entity-picker")) {
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      picker.value = this._editEntity;
      picker.addEventListener("value-changed", (ev) => {
        this._editEntity = (ev.detail && ev.detail.value) || "";
      });
      modal.appendChild(picker);
      setTimeout(() => picker.focus && picker.focus(), 0);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "ex: light.salon";
      input.value = this._editEntity || "";
      input.addEventListener("input", (e) => {
        this._editEntity = e.target.value.trim();
      });
      modal.appendChild(input);
    }

    this._buildNameIconFields(modal, {
      getName: () => this._editName,
      setName: (v) => {
        this._editName = v;
      },
      getIcon: () => this._editIcon,
      setIcon: (v) => {
        this._editIcon = v;
      },
      getShowName: () => this._editShowName,
      setShowName: (v) => {
        this._editShowName = v;
      },
    });

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Annuler";
    cancelBtn.addEventListener("click", () => this._cancelEdit());
    actions.appendChild(cancelBtn);

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn primary";
    confirmBtn.textContent = "Enregistrer";
    confirmBtn.addEventListener("click", () => this._confirmEditBadge());
    actions.appendChild(confirmBtn);

    modal.appendChild(actions);
    overlay.appendChild(modal);
    return overlay;
  }

  _buildEditGroupPanel() {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this._cancelEditGroup();
    });

    const modal = document.createElement("div");
    modal.className = "modal";

    const title = document.createElement("h3");
    title.textContent = "Modifier ce badge";
    modal.appendChild(title);

    const editableCount = this._editingGroup.occurrences.filter((o) => o.editable).length;
    const totalCount = this._editingGroup.occurrences.length;
    const info = document.createElement("div");
    info.className = "muted";
    info.style.marginBottom = "10px";
    if (editableCount === totalCount) {
      info.textContent = `Ce changement s'appliquera aux ${totalCount} vue${
        totalCount > 1 ? "s" : ""
      } où ce badge apparaît.`;
    } else {
      info.textContent = `Ce changement s'appliquera à ${editableCount} vue${
        editableCount > 1 ? "s" : ""
      } sur ${totalCount} (les vues en mode YAML, non éditables, seront ignorées).`;
    }
    modal.appendChild(info);

    const pickerLabel = document.createElement("div");
    pickerLabel.className = "field-label";
    pickerLabel.textContent = "Entité :";
    modal.appendChild(pickerLabel);

    if (customElements.get("ha-entity-picker")) {
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      picker.value = this._editEntity;
      picker.addEventListener("value-changed", (ev) => {
        this._editEntity = (ev.detail && ev.detail.value) || "";
      });
      modal.appendChild(picker);
      setTimeout(() => picker.focus && picker.focus(), 0);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "ex: light.salon";
      input.value = this._editEntity || "";
      input.addEventListener("input", (e) => {
        this._editEntity = e.target.value.trim();
      });
      modal.appendChild(input);
    }

    this._buildNameIconFields(modal, {
      getName: () => this._editName,
      setName: (v) => {
        this._editName = v;
      },
      getIcon: () => this._editIcon,
      setIcon: (v) => {
        this._editIcon = v;
      },
      getShowName: () => this._editShowName,
      setShowName: (v) => {
        this._editShowName = v;
      },
    });

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Annuler";
    cancelBtn.addEventListener("click", () => this._cancelEditGroup());
    actions.appendChild(cancelBtn);

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn primary";
    confirmBtn.textContent = "Enregistrer partout";
    confirmBtn.addEventListener("click", () => this._confirmEditGroupBadge());
    actions.appendChild(confirmBtn);

    modal.appendChild(actions);
    overlay.appendChild(modal);
    return overlay;
  }

  // Champs communs "nom personnalisé + affichage du nom + icône" utilisés
  // par les 3 panneaux (création, édition simple, édition groupée).
  _buildNameIconFields(modal, opts) {
    const nameLabel = document.createElement("div");
    nameLabel.className = "field-label";
    nameLabel.textContent = "Nom affiché (optionnel) :";
    modal.appendChild(nameLabel);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Laisser vide pour utiliser le nom de l'entité";
    nameInput.value = opts.getName() || "";
    nameInput.addEventListener("input", (e) => opts.setName(e.target.value));
    modal.appendChild(nameInput);

    const showNameRow = document.createElement("label");
    showNameRow.className = "checkbox-row";
    const showNameCb = document.createElement("input");
    showNameCb.type = "checkbox";
    showNameCb.checked = !!opts.getShowName();
    showNameCb.addEventListener("change", () => opts.setShowName(showNameCb.checked));
    showNameRow.appendChild(showNameCb);
    const showNameText = document.createElement("span");
    showNameText.textContent =
      "Afficher ce nom au-dessus de l'état (sinon seuls l'icône et l'état sont visibles)";
    showNameRow.appendChild(showNameText);
    modal.appendChild(showNameRow);

    const iconLabel = document.createElement("div");
    iconLabel.className = "field-label";
    iconLabel.textContent = "Icône (optionnel) :";
    modal.appendChild(iconLabel);

    if (customElements.get("ha-icon-picker")) {
      const iconPicker = document.createElement("ha-icon-picker");
      iconPicker.hass = this._hass;
      iconPicker.value = opts.getIcon() || "";
      iconPicker.addEventListener("value-changed", (ev) => {
        opts.setIcon((ev.detail && ev.detail.value) || "");
      });
      modal.appendChild(iconPicker);
    } else {
      const iconInput = document.createElement("input");
      iconInput.type = "text";
      iconInput.placeholder = "ex: mdi:thermometer";
      iconInput.value = opts.getIcon() || "";
      iconInput.addEventListener("input", (e) => {
        opts.setIcon(e.target.value.trim());
      });
      modal.appendChild(iconInput);
    }
  }

  _buildEntityPicker(dashIndex, viewIndex) {
    const container = document.createElement("div");
    container.className = "entity-picker-container";

    if (customElements.get("ha-entity-picker")) {
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      picker.style.minWidth = "260px";
      picker.addEventListener("value-changed", (ev) => {
        const entityId = ev.detail && ev.detail.value;
        if (entityId) {
          this._addBadge(dashIndex, viewIndex, entityId);
        }
      });
      container.appendChild(picker);
      setTimeout(() => picker.focus && picker.focus(), 0);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "ex: light.salon";
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          this._addBadge(dashIndex, viewIndex, input.value.trim());
        }
      });
      container.appendChild(input);
    }

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn small";
    cancelBtn.textContent = "Annuler";
    cancelBtn.addEventListener("click", () => {
      this._addingFor = null;
      this._buildStructure();
    });
    container.appendChild(cancelBtn);

    return container;
  }

  _applyFilter() {
    const root = this.shadowRoot;
    if (!root) return;
    const term = this._search;

    if (this._groupBy === "dashboard") {
      root.querySelectorAll(".view-section").forEach((section) => {
        const match = !term || section.dataset.search.includes(term);
        section.style.display = match ? "" : "none";
      });
      root.querySelectorAll(".dashboard-section").forEach((dashSection) => {
        const visible = Array.from(dashSection.querySelectorAll(".view-section")).some(
          (s) => s.style.display !== "none"
        );
        dashSection.style.display = visible ? "" : "none";
      });
    } else {
      root.querySelectorAll(".badge-group").forEach((group) => {
        const match = !term || group.dataset.search.includes(term);
        group.style.display = match ? "" : "none";
      });
    }
  }

  _renderShell(message) {
    const root = this.shadowRoot;
    root.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = this._css();
    root.appendChild(style);
    const page = document.createElement("div");
    page.className = "page";
    const header = document.createElement("div");
    header.className = "app-header";
    const h1 = document.createElement("h1");
    h1.textContent = "Badges — vue d'ensemble";
    header.appendChild(h1);
    page.appendChild(header);
    const content = document.createElement("div");
    content.className = "content";
    content.textContent = message;
    page.appendChild(content);
    root.appendChild(page);
  }

  _css() {
    return `
      :host {
        display: block;
        background: var(--primary-background-color, #fafafa);
        min-height: 100vh;
      }
      .page { max-width: 1100px; margin: 0 auto; }
      .app-header {
        padding: 16px 20px;
        border-bottom: 1px solid var(--divider-color, #eee);
        background: var(--card-background-color, #fff);
      }
      .app-header h1 {
        margin: 0;
        font-size: 20px;
        color: var(--primary-text-color, #000);
      }
      .content { padding: 16px 20px 40px; }
      .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      .toolbar input[type="search"] {
        flex: 1;
        min-width: 160px;
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid var(--divider-color, #ccc);
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #000);
        font-size: 14px;
      }
      .segmented {
        display: inline-flex;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 8px;
        overflow: hidden;
      }
      .segment {
        padding: 6px 12px;
        border: none;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #000);
        cursor: pointer;
        font-size: 13px;
      }
      .segment.active {
        background: var(--primary-color, #03a9f4);
        color: white;
      }
      .btn {
        padding: 6px 12px;
        border-radius: 8px;
        border: 1px solid var(--divider-color, #ccc);
        background: var(--secondary-background-color, #f0f0f0);
        color: var(--primary-text-color, #000);
        cursor: pointer;
        font-size: 13px;
      }
      .btn.small { font-size: 12px; padding: 4px 8px; }
      .btn.primary {
        background: var(--primary-color, #03a9f4);
        color: white;
        border-color: transparent;
      }
      .btn:hover { filter: brightness(0.95); }
      .summary { font-size: 12px; color: var(--secondary-text-color, #888); margin-bottom: 12px; }
      .pending-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        background: #fff8e1;
        border: 1px solid #ffe082;
        border-radius: 10px;
        padding: 8px 12px;
        margin-bottom: 16px;
      }
      .pending-label { font-size: 13px; color: #8a6d00; }
      .error { color: var(--error-color, #db4437); font-size: 13px; margin-bottom: 8px; }
      .muted { color: var(--secondary-text-color, #888); font-size: 13px; font-style: italic; }
      .dashboard-section {
        margin-bottom: 24px;
        background: var(--card-background-color, #fff);
        border-radius: 12px;
        padding: 14px 16px;
        box-shadow: var(--ha-card-box-shadow, 0 1px 3px rgba(0,0,0,0.08));
      }
      .dashboard-header {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }
      .dashboard-header h2 {
        font-size: 17px;
        margin: 0;
        color: var(--primary-text-color, #000);
        flex: 1;
      }
      .mode-tag {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 10px;
        background: var(--secondary-background-color, #eee);
        color: var(--secondary-text-color, #666);
      }
      .mode-storage { background: #e3f6e8; color: #1b7a3d; }
      .mode-yaml { background: #fdeeea; color: #b3441c; }
      .view-section {
        margin-bottom: 12px;
        padding: 8px 10px;
        border-radius: 10px;
        background: var(--secondary-background-color, rgba(0,0,0,0.03));
      }
      .view-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
      .view-title { font-weight: 600; font-size: 14px; flex: 1; }
      .badge-count { font-size: 12px; color: var(--secondary-text-color, #888); }
      .badge-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-height: 32px; }
      .badge-wrap { position: relative; display: inline-flex; }
      .remove-badge-btn {
        position: absolute;
        top: -6px;
        right: -6px;
        width: 16px;
        height: 16px;
        line-height: 14px;
        border-radius: 50%;
        border: none;
        background: var(--error-color, #db4437);
        color: white;
        font-size: 12px;
        cursor: pointer;
        padding: 0;
      }
      .edit-badge-btn {
        position: absolute;
        top: -6px;
        left: -6px;
        width: 16px;
        height: 16px;
        line-height: 14px;
        border-radius: 50%;
        border: none;
        background: var(--primary-color, #03a9f4);
        color: white;
        font-size: 10px;
        cursor: pointer;
        padding: 0;
      }
      .add-badge-btn {
        padding: 4px 10px;
        border-radius: 14px;
        border: 1px dashed var(--divider-color, #bbb);
        background: transparent;
        color: var(--secondary-text-color, #888);
        cursor: pointer;
        font-size: 12px;
      }
      .add-badge-btn:hover { border-color: var(--primary-color, #03a9f4); color: var(--primary-color, #03a9f4); }
      .entity-picker-container { display: flex; gap: 6px; align-items: center; }
      .entity-picker-container input[type="text"] {
        padding: 6px 8px;
        border-radius: 8px;
        border: 1px solid var(--divider-color, #ccc);
      }
      .fallback-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 10px;
        border-radius: 14px;
        background: var(--card-background-color, #fff);
        border: 1px solid var(--divider-color, #ddd);
        font-size: 12px;
        color: var(--primary-text-color, #000);
      }
      .fallback-badge.missing { border-color: var(--error-color, #db4437); color: var(--error-color, #db4437); }
      .fallback-badge ha-icon { --mdc-icon-size: 16px; }

      /* Mode "par badge" */
      .badge-group-list { display: flex; flex-direction: column; gap: 10px; }
      .badge-group {
        background: var(--card-background-color, #fff);
        border-radius: 12px;
        padding: 12px 16px;
        box-shadow: var(--ha-card-box-shadow, 0 1px 3px rgba(0,0,0,0.08));
      }
      .badge-group-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
      .occurrence-list { display: flex; flex-wrap: wrap; gap: 6px; }
      .occurrence-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 8px;
        border-radius: 12px;
        background: var(--secondary-background-color, rgba(0,0,0,0.05));
        font-size: 12px;
      }
      .occurrence-label { cursor: pointer; color: var(--primary-text-color, #000); }
      .occurrence-label:hover { color: var(--primary-color, #03a9f4); text-decoration: underline; }
      .remove-occurrence-btn {
        width: 14px; height: 14px; line-height: 12px;
        border-radius: 50%; border: none;
        background: var(--error-color, #db4437); color: white;
        font-size: 11px; cursor: pointer; padding: 0;
      }
      .edit-occurrence-btn {
        width: 14px; height: 14px; line-height: 12px;
        border-radius: 50%; border: none;
        background: var(--primary-color, #03a9f4); color: white;
        font-size: 9px; cursor: pointer; padding: 0;
      }

      /* Panneau de création */
      .overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        z-index: 1000;
        padding: 16px;
      }
      .modal {
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #000);
        border-radius: 12px;
        padding: 20px;
        width: 100%;
        max-width: 480px;
        max-height: 85vh;
        overflow-y: auto;
      }
      .modal h3 { margin: 0 0 12px 0; }
      .field-label { font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
      .checkbox-row {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        font-size: 12px;
        color: var(--secondary-text-color, #666);
        margin: 6px 0;
        cursor: pointer;
      }
      .checkbox-row input[type="checkbox"] { margin-top: 2px; }
      .modal input[type="text"] {
        width: 100%;
        box-sizing: border-box;
        padding: 8px;
        border-radius: 8px;
        border: 1px solid var(--divider-color, #ccc);
      }
      .targets-list { max-height: 280px; overflow-y: auto; border: 1px solid var(--divider-color, #eee); border-radius: 8px; padding: 8px; }
      .target-dash-group { margin-bottom: 10px; }
      .target-dash-header { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; margin-bottom: 4px; }
      .target-row { display: flex; align-items: center; gap: 6px; font-size: 13px; padding: 2px 0 2px 18px; cursor: pointer; }
      .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    `;
  }
}

// Chaque tag personnalisé doit avoir son propre constructeur (le navigateur
// refuse d'enregistrer deux fois la même classe sous des noms différents),
// d'où ces deux sous-classes vides qui héritent du même comportement.
class BadgesOverviewCardEl extends BadgesOverviewApp {}
class BadgesOverviewPanelEl extends BadgesOverviewApp {}

customElements.define("badges-overview-card", BadgesOverviewCardEl);
customElements.define("badges-overview-panel", BadgesOverviewPanelEl);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "badges-overview-card",
  name: "Vue d'ensemble des badges",
  description:
    "Affiche et permet d'éditer tous les badges de toutes les vues de tous les tableaux de bord.",
});
