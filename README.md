# Badges — App de gestion centralisée pour Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)

Affiche, sur une seule page, **tous les badges** de **toutes les vues** de
**tous tes tableaux de bord**, regroupés et rendus tels qu'ils apparaissent
réellement. Permet aussi de **créer**, **éditer**, **affecter à plusieurs
vues d'un coup** et de **supprimer** des badges directement depuis cette
page.

## Installation (recommandée) : via HACS, en tant qu'intégration

Cette méthode n'écrit **rien** dans `configuration.yaml` : tout passe par
l'interface graphique de Home Assistant.

1. HACS → menu **⋮** (en haut à droite) → **Dépôts personnalisés**.
2. Colle l'URL de ce dépôt GitHub, catégorie **Intégration**.
3. Recherche "Badges Overview" dans HACS → **Télécharger**.
4. Redémarre Home Assistant (nécessaire après l'ajout d'une nouvelle
   intégration).
5. **Paramètres → Appareils et services → Ajouter une intégration** →
   cherche "Badges Overview" → clique **Envoyer** (aucun champ à
   remplir).

Un item **"Badges"** apparaît alors dans la barre latérale. Les mises à
jour futures se font en un clic depuis HACS + un redémarrage — jamais
besoin de copier de fichier ni de toucher `configuration.yaml`.

Pour désinstaller : Paramètres → Appareils et services → Badges Overview →
Supprimer, puis désinstalle depuis HACS.

## Comment ça marche (pour comprendre ce qui a changé)

L'intégration (dossier `custom_components/badges_overview/`) fait en
Python, au démarrage de Home Assistant, exactement ce que tu aurais dû
écrire à la main dans `configuration.yaml` avec `panel_custom` :
- elle sert le fichier `badges-overview-card.js` embarqué à une URL
  interne (`/badges_overview_static/...`) ;
- elle enregistre le panneau "Badges" dans la barre latérale.

Comme c'est un *config entry* (créé via l'assistant d'ajout d'intégration)
et non une ligne de YAML, la configuration est stockée par Home Assistant
lui-même — rien à écrire, rien à faire à la main.

## Alternative : installation manuelle (sans intégration, sans HACS)

Si tu préfères ne pas utiliser HACS, ou pour du dépannage, le fichier
`badges-overview-card.js` à la racine du dépôt fonctionne aussi de façon
autonome, en carte Lovelace classique ou en panneau via `panel_custom` :

1. Copier `badges-overview-card.js` dans `/config/www/`.
2. **Option panneau** (déclare dans `configuration.yaml`) :
   ```yaml
   panel_custom:
     - name: badges-overview-panel
       sidebar_title: Badges
       sidebar_icon: mdi:badge-account-horizontal
       url_path: badges-overview
       module_url: /local/badges-overview-card.js
       embed_iframe: false
       trust_external_script: true
   ```
   **Option carte** (pas de YAML, ajoute juste une ressource Lovelace) :
   Paramètres → Tableaux de bord → **⋮** → Ressources → Ajouter une
   ressource : URL `/local/badges-overview-card.js`, type **Module
   JavaScript**, puis ajoute une carte "Manuelle" avec
   `type: custom:badges-overview-card`.
3. Redémarrer Home Assistant.

⚠️ Si tu modifies le fichier JS toi-même dans cette configuration
manuelle, pense à incrémenter une version dans l'URL
(`?v=2`) pour forcer le rechargement, le cache navigateur pouvant être
tenace.

## Édition : ce qui est possible ou non

- **Tableaux de bord en mode UI (storage)** : entièrement éditables depuis
  l'app. Les modifications sont envoyées à Home Assistant via
  `lovelace/config/save`, exactement comme si tu éditais depuis l'éditeur
  Lovelace normal.
- **Tableaux de bord en mode YAML** : ce sont des fichiers sur disque,
  l'API ne peut pas y écrire. Ils s'affichent en lecture seule avec un
  badge "Mode YAML".
- **Mode indéterminé** : édition désactivée par défaut, avec un bouton
  "Forcer l'édition (à vos risques)" si tu veux quand même tenter.

## Fonctionnalités

- Deux modes d'affichage inversables : **par tableau de bord** ou **par
  badge** (chaque badge unique avec la liste des vues où il apparaît).
- **Création** d'un badge avec affectation simultanée à plusieurs vues de
  plusieurs tableaux de bord.
- **Édition** d'un badge existant (entité, nom affiché, icône), qui se
  propage à toutes ses occurrences en mode "par badge".
- **Suppression** ciblée, par vue ou par occurrence.
- Champ **nom personnalisé** avec case "Afficher ce nom au-dessus de
  l'état", et **sélecteur d'icône natif**.
- Barre de sauvegarde visible dans les deux modes d'affichage.
- Recherche, bouton d'actualisation, déduplication automatique des
  tableaux de bord en double.
- Repli visuel si le composant interne `hui-badge` n'est pas disponible.

## Limites connues

- Seuls les badges de type "entité" sont gérés à la création/édition (le
  cas le plus courant). Les badges déjà existants d'un autre type
  s'affichent normalement en lecture.
- Pas de réordonnancement par glisser-déposer pour l'instant.
- Le rendu fidèle dépend du composant interne `hui-badge`, qui n'est pas
  une API publique documentée par Home Assistant.

## Changelog

### v1.0 — Intégration HACS
- Nouveau mode d'installation : intégration Python installable via
  Paramètres → Appareils et services, sans toucher `configuration.yaml`.

### v3.4
- Barre "modifications non enregistrées" visible dans les deux modes
  d'affichage.

### v3.3
- Case "Afficher le nom" (`show_name`) pour que le nom personnalisé
  s'affiche réellement sur le badge natif.
- Sélecteur d'icône natif.

### v3.2
- Édition d'un badge en mode "par badge" appliquée à toutes ses
  occurrences en un clic, au lieu d'une édition par occurrence
  individuelle.

### v3.1
- Édition d'un badge existant (entité + nom personnalisé).

### v3
- Inversion d'affichage "par tableau de bord" / "par badge".
- Création globale avec affectation multi-vues.

### v2
- Passage en panneau dédié (`panel_custom`) avec ajout/suppression de
  badges et sauvegarde vers Home Assistant.

### v1
- Carte Lovelace en lecture seule listant tous les badges de tous les
  tableaux de bord.
