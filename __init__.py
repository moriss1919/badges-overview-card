"""The Badges Overview integration.

Enregistre un panneau personnalisé ("Badges") dans la barre latérale de
Home Assistant et sert son fichier JavaScript, sans nécessiter la moindre
entrée dans configuration.yaml : tout se fait via un config entry créé par
Paramètres > Appareils et services > Ajouter une intégration.
"""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import async_remove_panel
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.panel_custom import async_register_panel
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

DOMAIN = "badges_overview"

# Chemin de la page dans la barre latérale : https://<ton-ha>/badges-overview
PANEL_URL_PATH = "badges-overview"
SIDEBAR_TITLE = "Badges"
SIDEBAR_ICON = "mdi:badge-account-horizontal"

# Nom du custom element défini dans badges-overview-card.js
WEBCOMPONENT_NAME = "badges-overview-panel"

# URL statique à laquelle le fichier JS de l'intégration sera servi
STATIC_URL_BASE = "/badges_overview_static"
JS_FILENAME = "badges-overview-card.js"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Badges Overview from a config entry (appelé à l'installation et à chaque démarrage de HA)."""
    www_dir = Path(__file__).parent / "www"

    # Sert le fichier JS de l'intégration. cache_headers=False pour éviter
    # les soucis de cache navigateur lors des mises à jour de l'intégration.
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL_BASE, str(www_dir), False)]
    )

    await async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=WEBCOMPONENT_NAME,
        sidebar_title=SIDEBAR_TITLE,
        sidebar_icon=SIDEBAR_ICON,
        module_url=f"{STATIC_URL_BASE}/{JS_FILENAME}",
        embed_iframe=False,
        trust_external=True,
        require_admin=False,
    )

    _LOGGER.debug("Panneau Badges Overview enregistré sur /%s", PANEL_URL_PATH)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry (appelé si l'utilisateur désinstalle/supprime l'intégration)."""
    async_remove_panel(hass, PANEL_URL_PATH)
    return True
