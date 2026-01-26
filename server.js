// =====================================================
// IMPORTAÇÕES
// =====================================================
const express = require("express");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const session = require("express-session");
const PDFDocument = require("pdfkit");

const NOME_EMPRESA = "AGRICOLA HORIZONTE";
const CAMINHO_LOGO = path.join(__dirname, "public/img/logo.png");


// =====================================================
// APP
// =====================================================
const app = express();

// =====================================================
// MIDDLEWARES
// =====================================================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: "pac4200_intranet",
  resave: false,
  saveUninitialized: false
}));

app.use("/public", express.static(path.join(__dirname, "public")));

// =====================================================
// BANCO DE DADOS
// =====================================================
const db = new sqlite3.Database("./energia.db");

const dbUsers = new sqlite3.Database("./usuarios.db", (err) => {
  if (err) {
    console.error("❌ Erro ao abrir usuarios.db:", err.message);
  } else {
    console.log("✅ usuarios.db conectado/criado");
  }
});

dbUsers.serialize(() => {
  dbUsers.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE,
      senha TEXT,
      perfil TEXT
    )
  `);

  dbUsers.run(`
    INSERT OR IGNORE INTO usuarios (usuario, senha, perfil)
    VALUES
      ('admin', 'admin123', 'admin'),
      ('operador', 'operador123', 'operador'),
      ('leitura', 'leitura123', 'leitura')
  `);
});

// =====================================================
// MIDDLEWARE DE SEGURANÇA
// =====================================================
function precisaLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  next();
}

function precisaAdmin(req, res, next) {
  if (req.session.user?.perfil !== "admin") {
    return res.status(403).send("Acesso negado");
  }
  next();
}

function formatarMesAno(yyyyMM) {
  const [ano, mes] = yyyyMM.split("-");
  const data = new Date(ano, mes - 1, 1);

  const texto = data.toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric"
  });

  // Primeira letra maiúscula
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}


// =====================================================
// ROTAS DE LOGIN
// =====================================================
app.post("/login", (req, res) => {
  const { usuario, senha } = req.body;

  dbUsers.get(
    "SELECT * FROM usuarios WHERE usuario=? AND senha=?",
    [usuario, senha],
    (err, user) => {
      if (!user) return res.redirect("/login.html?erro=1");

      req.session.user = {
        usuario: user.usuario,
        perfil: user.perfil
      };

      res.redirect("/");
    }
  );
});

app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public/login.html"));
});


app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("public/login.html");
  });
});

// =====================================================
// DASHBOARD
// =====================================================
app.get("/", precisaLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// =====================================================
// DEFINIÇÃO DOS PACs
// =====================================================
const pacs = [
  { id: "PAC_01", nome: "TRAFO 1" },
  { id: "PAC_02", nome: "MACERAÇÃO" },
  { id: "PAC_03", nome: "SECADOR" }
];

// =====================================================
// SIMULAÇÃO DE ENERGIA
// =====================================================
const energiaSimulada = {};
pacs.forEach(p => energiaSimulada[p.id] = 1000);

function lerEnergia(pacId) {
  energiaSimulada[pacId] += Math.random() * 2;
  return Number(energiaSimulada[pacId].toFixed(2));
}

// =====================================================
// ATUALIZAÇÃO DURANTE O DIA
// =====================================================
function atualizarDuranteODia() {
  const hoje = new Date().toISOString().substring(0, 10);

  pacs.forEach(pac => {
    const energiaAtual = lerEnergia(pac.id);

    db.get(
      "SELECT * FROM energia_diaria WHERE pac_id=? AND data=?",
      [pac.id, hoje],
      (err, row) => {
        if (!row) {
          db.run(
            `INSERT INTO energia_diaria
             (pac_id, data, energia_inicio, energia_fim, consumo)
             VALUES (?, ?, ?, ?, ?)`,
            [pac.id, hoje, energiaAtual, energiaAtual, 0]
          );
        } else {
          const consumo = energiaAtual - row.energia_inicio;
          db.run(
            `UPDATE energia_diaria
             SET energia_fim=?, consumo=?
             WHERE pac_id=? AND data=?`,
            [energiaAtual, consumo, pac.id, hoje]
          );
        }
      }
    );
  });
}

setInterval(atualizarDuranteODia, 10000);

// =====================================================
// APIs
// =====================================================
app.get("/api/pacs", precisaLogin, (req, res) => res.json(pacs));

app.get("/api/consumo/:pacId", precisaLogin, (req, res) => {
  db.all(
    "SELECT * FROM energia_diaria WHERE pac_id=? ORDER BY data",
    [req.params.pacId],
    (err, rows) => res.json(rows)
  );
});

// =====================================================
// RANKING MENSAL
// =====================================================
app.get("/api/ranking/mensal/:mes", precisaLogin, (req, res) => {
  const mes = req.params.mes;

  db.all(
    `
    SELECT pac_id, SUM(consumo) total
    FROM energia_diaria
    WHERE substr(data,1,7)=?
    GROUP BY pac_id
    ORDER BY total DESC
    `,
    [mes],
    (err, rows) => {
      const ranking = rows.map((r, i) => {
        const pac = pacs.find(p => p.id === r.pac_id);
        return {
          posicao: i + 1,
          nome: pac ? pac.nome : r.pac_id,
          consumo: Number(r.total.toFixed(2))
        };
      });

      res.json({ mes, ranking });
    }
  );
});

function cabecalhoPDF(doc, titulo) {
  // Logo
  if (fs.existsSync(CAMINHO_LOGO)) {
    doc.image(CAMINHO_LOGO, 50, 40, { width: 80 });
  }

  // Nome da empresa
  doc
    .fontSize(16)
    .text(NOME_EMPRESA, 150, 45);

  // Título do relatório
  doc
    .fontSize(14)
    .text(titulo, 150, 70);

  // Linha separadora
  doc
    .moveTo(50, 105)
    .lineTo(545, 105)
    .stroke();

  doc.moveDown(3);
}

function rodapePDF(doc) {
  const data = new Date().toLocaleString("pt-BR");

  doc.on("pageAdded", () => {
    const page = doc.page;

    doc
      .fontSize(9)
      .fillColor("gray")
      .text(
        `Confidencial – Uso interno | Gerado em ${data}`,
        50,
        page.height - 50,
        { align: "left" }
      );

    doc
      .fontSize(9)
      .fillColor("gray")
      .text(
        `Página ${doc.page.pageNumber}`,
        50,
        page.height - 50,
        { align: "right" }
      );

    doc.fillColor("black");
  });
}



// =====================================================
// PDF MENSAL – TODOS OS PACs (RANKING GERAL)
// =====================================================
app.get("/api/relatorio/mensal/pdf/:mes", (req, res) => {
  const mes = req.params.mes;

  console.log("🧾 Gerando PDF mensal geral:", mes);

  const sql = `
    SELECT pac_id, SUM(consumo) AS total
    FROM energia_diaria
    WHERE substr(data,1,7)=?
    GROUP BY pac_id
    ORDER BY total DESC
  `;

  db.all(sql, [mes], (err, rows) => {
    if (err) return res.status(500).send(err.message);

    let totalGeral = 0;
    const mapa = {};
    rows.forEach(r => {
      mapa[r.pac_id] = r.total || 0;
      totalGeral += r.total || 0;
    });

    const doc = new PDFDocument({ size: "A4", margin: 50 });
     rodapePDF(doc);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=Relatorio_Geral_${mes}.pdf`
    );


    const pasta = path.join(__dirname, "relatorios");
    if (!fs.existsSync(pasta)) fs.mkdirSync(pasta);

    const file = fs.createWriteStream(
      path.join(pasta, `Relatorio_Geral_${mes}_${Date.now()}.pdf`)
    );

    doc.pipe(res);
    doc.pipe(file);

   // doc.fontSize(20).text("Relatório Mensal de Consumo de Energia", { align: "center" });
    //
    cabecalhoPDF(doc, "Relatório Mensal de Consumo de Energia");
    doc.moveDown();
    doc.text("Mês: " + formatarMesAno(mes));
    doc.moveDown(2);

    pacs
      .map(p => ({
        nome: p.nome,
        consumo: mapa[p.id] || 0
      }))
      .sort((a, b) => b.consumo - a.consumo)
      .forEach((p, i) => {
        doc.text(`${i + 1}º ${p.nome} — ${p.consumo.toFixed(2)} kWh`);
      });

    doc.moveDown(2);
    doc.text(`Total Geral: ${totalGeral.toFixed(2)} kWh`);
    doc.moveDown();
    doc.text(`Gerado em: ${new Date().toLocaleString("pt-BR")}`);

    doc.end();
  });
});


// =====================================================
// PDF COMPARATIVO MENSAL POR PAC (ADMIN)
// =====================================================
app.get("/api/relatorio/comparar/pdf/:pacId/:mes1/:mes2", precisaAdmin, (req, res) => {
  const { pacId, mes1, mes2 } = req.params;

  console.log("📊 PDF comparativo:", pacId, mes1, mes2);

  const pac = pacs.find(p => p.id === pacId);
  const nomePAC = pac ? pac.nome : pacId;

  function consumoMes(mes) {
    return new Promise((resolve, reject) => {
      db.get(
        `
        SELECT SUM(consumo) AS total
        FROM energia_diaria
        WHERE pac_id = ?
          AND substr(data,1,7) = ?
        `,
        [pacId, mes],
        (err, row) => {
          if (err) reject(err);
          resolve(row?.total || 0);
        }
      );
    });
  }

  Promise.all([consumoMes(mes1), consumoMes(mes2)])
    .then(([total1, total2]) => {

      const diff = total2 - total1;
      const status =
        diff > 0 ? "Aumento" :
        diff < 0 ? "Redução" : "Sem variação";

      const doc = new PDFDocument({ size: "A4", margin: 50 });
      rodapePDF(doc);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename=Comparativo_${pacId}_${mes1}_${mes2}.pdf`
      );

      const pasta = path.join(__dirname, "relatorios");
      if (!fs.existsSync(pasta)) fs.mkdirSync(pasta);

      const file = fs.createWriteStream(
        path.join(pasta, `Comparativo_${pacId}_${mes1}_${mes2}_${Date.now()}.pdf`)
      );

      doc.pipe(res);
      doc.pipe(file);

      // ===== CONTEÚDO =====
      //doc.fontSize(20).text("Relatório Comparativo de Consumo", { align: "center" });
      cabecalhoPDF(doc, "Relatório Comparativo de Consumo de Energia");
      doc.moveDown(2);

      doc.fontSize(12).text(`PAC: ${nomePAC}`);
      doc.moveDown();

      doc.text(`Mês ${mes1}: ${total1.toFixed(2)} kWh`);
      doc.text(`Mês ${mes2}: ${total2.toFixed(2)} kWh`);
      doc.moveDown();

      doc.text(`Diferença: ${diff.toFixed(2)} kWh (${status})`);
      doc.moveDown();

      if (total1 === 0) doc.fillColor("red").text(`⚠ Sem dados para ${mes1}`);
      if (total2 === 0) doc.fillColor("red").text(`⚠ Sem dados para ${mes2}`);
      doc.fillColor("black").moveDown();

      doc.fontSize(10).text(`Gerado em: ${new Date().toLocaleString("pt-BR")}`);

      doc.end();
    })
    .catch(err => {
      console.error(err);
      res.status(500).send(err.message);
    });
});

http://localhost:3000/api/relatorio/comparar/pdf/PAC_01/2026-01/2026-02


// =====================================================
// START DO SERVIDOR
// =====================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Servidor EnergyControl rodando");
  console.log(`🌐 Porta: ${PORT}`);
});




//app.listen(3000, () => {
//  console.log("🚀 Servidor PAC4200 rodando");
//  console.log("🌐 http://localhost:3000");
//});

