"""Config flow for Badges Overview.

Flux minimal : pas de champ à remplir, l'utilisateur confirme simplement
l'installation depuis Paramètres > Appareils et services > Ajouter une
intégration. Une seule instance est autorisée (le panneau n'a pas besoin
d'être ajouté plusieurs fois).
"""
from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries

from . import DOMAIN


class BadgesOverviewConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Badges Overview."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Étape unique : confirmation, puis création de l'entrée."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(title="Badges Overview", data={})

        return self.async_show_form(step_id="user", data_schema=vol.Schema({}))
