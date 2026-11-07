# qingping-mcp

Serveur [MCP](https://modelcontextprotocol.io) pour les capteurs d'air **Qingping** (Air Monitor CGS1, Air Monitor 2, Lite, thermomètres…), via l'[Open API cloud officielle](https://developer.qingping.co/cloud-to-cloud/open-apis).

Il permet de demander à Claude (ou à tout client MCP) : « quel est le CO₂ dans la chambre ? », « le CO₂ a-t-il dépassé 1000 ppm cette nuit ? », « montre-moi la courbe de PM2.5 sur 7 jours ».

## Outils

| Outil | Rôle |
|---|---|
| `qingping_current` | Dernières mesures (CO₂, PM2.5, PM10, tVOC, température, humidité, batterie…) avec un niveau lisible (bon / élevé — aérer…) |
| `qingping_history` | Historique sur une période : min / max / moyenne par métrique, heure du pic, minutes au-dessus des seuils (CO₂ > 1000 / 1500 ppm, PM2.5 > 15 / 35, humidité > 60 / 70 %), série optionnelle pour tracer une courbe |
| `qingping_alerts` | Alertes déclenchées (seuils réglés dans l'app) |
| `qingping_set_intervals` | Intervalles de mesure et d'envoi au cloud |

## Installation

1. Sur [developer.qingping.co](https://developer.qingping.co), connectez-vous avec le compte de l'app Qingping+ / Qingping IoT où sont vos capteurs, puis **Access management** → copiez l'**App Key** et l'**App Secret**.
2. Construisez le serveur :

   ```sh
   git clone https://github.com/nicolascoutureau/qingping-mcp.git
   cd qingping-mcp
   npm install && npm run build
   ```

3. Mettez les clés dans un fichier `.env` à la racine (il n'est pas versionné) :

   ```sh
   QINGPING_APP_KEY=...
   QINGPING_APP_SECRET=...
   ```

   ou passez-les en variables d'environnement.
4. Ajoutez le serveur à Claude Code :

   ```sh
   claude mcp add -s user qingping -- node /chemin/vers/qingping-mcp/dist/index.js
   ```

## Dépannage

- **L'appareil apparaît mais sans aucune mesure** (`readingAt: null`, historique vide, « No historical data » dans l'app) : le capteur n'atteint pas le cloud Qingping. Vérifiez la date et l'heure affichées sur le capteur : si elles sont fausses (ex. 2015), il est connecté au Wi-Fi mais pas à Internet. Réinitialisez son Wi-Fi et réappairez-le dans l'app (réseau 2,4 GHz). Les valeurs « Now » de l'app peuvent arriver en Bluetooth et masquer le problème.
- **Fraîcheur** : le cloud ne connaît que ce que le capteur envoie (15 min par défaut). `qingping_set_intervals` permet de descendre à quelques minutes pour un appareil sur secteur.
- **tVOC** : l'API le renvoie en ppb (l'app l'affiche en mg/m³).

## Développement

```sh
npm test          # tests (API simulée)
npm run inspect   # MCP Inspector
```

## Licence

MIT
